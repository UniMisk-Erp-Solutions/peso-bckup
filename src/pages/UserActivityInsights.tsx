import { useState } from "react";
import { useOrganizationIdentityMode } from "@/hooks/useOrganizationIdentityMode";
import { employeeIdFromSyntheticEmail } from "@/lib/personIdentitySearch";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Activity,
  Users,
  Clock,
  FileText,
  Search,
  AlertCircle,
  CalendarDays,
  TrendingDown,
  Eye,
  ShieldCheck,
  XCircle,
} from "lucide-react";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatVisibleTime(seconds: number): string {
  if (seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatLastSeen(ts: string | null): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1)  return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7)  return `${diffDays} days ago`;
  return d.toLocaleDateString();
}

/** Format a clock time from a full timestamp, e.g. "09:42 AM" */
function formatClockTime(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/** Format a date-only string safely (avoids UTC shift) e.g. "13 Jul" */
function formatDateOnly(dateString: string): string {
  const d = new Date(`${dateString}T00:00:00`);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Format a date-only string to a longer label e.g. "Sunday, 13 Jul 2025" */
function formatLongDate(dateString: string): string {
  const d = new Date(`${dateString}T00:00:00`);
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Returns the max visible_seconds across the timeline (used for progress bar scale). */
function getMaxVisibleSeconds(timeline: TimelineRow[]): number {
  const max = Math.max(...timeline.map((r) => r.visible_seconds), 0);
  return Math.max(max, 3600); // floor at 1 hour so bars aren't always full
}

function getTrendLabel(row: ActivitySummaryRow): "Active" | "Stable" | "Inactive" {
  if (!row.last_seen_at) return "Inactive";
  const diffDays = Math.floor(
    (Date.now() - new Date(row.last_seen_at).getTime()) / 86_400_000
  );
  if (diffDays <= 1) return "Active";
  if (diffDays <= 7) return "Stable";
  return "Inactive";
}

function dateRangeFromDays(days: number): { start: string; end: string } {
  const end   = new Date();
  const start = new Date(Date.now() - (days - 1) * 86_400_000);
  const fmt   = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActivitySummaryRow {
  user_id:                  string;
  name:                     string;
  email:                    string;
  employee_id:              string | null;
  role:                     string;
  last_seen_at:             string | null;
  first_seen_in_range:      string | null;
  today_visible_seconds:    number;
  today_expenses_submitted: number;
  active_days:              number;
  inactive_days:            number;
  current_inactive_streak:  number;
  total_visible_seconds:    number;
  total_expenses_submitted: number;
}

interface TimelineRow {
  activity_date:            string;
  visible_seconds:          number;
  session_count:            number;
  expenses_submitted_count: number;
  first_seen_at:            string | null;
  last_seen_at:             string | null;
  is_active:                boolean;
}

// ─── Feature-disabled placeholder ────────────────────────────────────────────

function FeatureDisabledCard() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-md w-full shadow-lg border-0 bg-white/80">
        <CardContent className="p-8 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Activity className="h-8 w-8 text-gray-400" />
          </div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">
            User Activity Insights is not enabled
          </h2>
          <p className="text-gray-500 text-sm">
            This feature is not enabled for your organization. Ask your master admin to enable
            &quot;User Activity Insights&quot; in the organization feature settings.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Summary cards (main page) ────────────────────────────────────────────────

function SummaryCards({ rows }: { rows: ActivitySummaryRow[] }) {
  const activeToday   = rows.filter(r => r.today_visible_seconds > 0).length;
  const inactiveToday = rows.length - activeToday;
  const totalSecToday = rows.reduce((s, r) => s + r.today_visible_seconds, 0);
  const expToday      = rows.reduce((s, r) => s + r.today_expenses_submitted, 0);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Card className="border-0 bg-white/80 shadow">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center shrink-0">
            <Users className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{activeToday}</p>
            <p className="text-xs text-gray-500">Active today</p>
          </div>
        </CardContent>
      </Card>
      <Card className="border-0 bg-white/80 shadow">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center shrink-0">
            <AlertCircle className="h-5 w-5 text-orange-500" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{inactiveToday}</p>
            <p className="text-xs text-gray-500">Inactive today</p>
          </div>
        </CardContent>
      </Card>
      <Card className="border-0 bg-white/80 shadow">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center shrink-0">
            <Clock className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{formatVisibleTime(totalSecToday)}</p>
            <p className="text-xs text-gray-500">Total app time today</p>
          </div>
        </CardContent>
      </Card>
      <Card className="border-0 bg-white/80 shadow">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center shrink-0">
            <FileText className="h-5 w-5 text-purple-600" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{expToday}</p>
            <p className="text-xs text-gray-500">Expenses submitted today</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Trend badge ──────────────────────────────────────────────────────────────

function TrendBadge({ row }: { row: ActivitySummaryRow }) {
  const trend = getTrendLabel(row);
  if (trend === "Active")
    return <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border-green-200">Active</Badge>;
  if (trend === "Stable")
    return <Badge className="bg-yellow-100 text-yellow-700 hover:bg-yellow-100 border-yellow-200">Stable</Badge>;
  return <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border-gray-200">Inactive</Badge>;
}

// ─── Drawer mini summary card ─────────────────────────────────────────────────

function MiniCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div className={`rounded-xl p-3 flex items-center gap-2 ${color}`}>
      <div className="shrink-0">{icon}</div>
      <div>
        <p className="text-base font-bold text-gray-900 leading-tight">{value}</p>
        <p className="text-[11px] text-gray-500 leading-tight">{label}</p>
      </div>
    </div>
  );
}

// ─── Desktop daily log table row ──────────────────────────────────────────────

function DailyLogRow({ row, maxSecs }: { row: TimelineRow; maxSecs: number }) {
  const pct = maxSecs > 0
    ? Math.min(100, Math.round((row.visible_seconds / maxSecs) * 100))
    : 0;

  return (
    <tr
      className={`border-b last:border-0 text-sm transition-colors ${
        row.is_active
          ? "bg-white hover:bg-green-50/40"
          : "bg-gray-50/60 hover:bg-gray-100/60"
      }`}
    >
      {/* Date */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className={`text-xs font-mono font-semibold ${row.is_active ? "text-gray-800" : "text-gray-400"}`}>
          {formatLongDate(row.activity_date)}
        </div>
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        {row.is_active ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
            Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block" />
            Inactive
          </span>
        )}
      </td>

      {/* First used */}
      <td className="px-4 py-3 tabular-nums text-xs text-gray-600 whitespace-nowrap">
        {formatClockTime(row.first_seen_at)}
      </td>

      {/* Last used */}
      <td className="px-4 py-3 tabular-nums text-xs text-gray-600 whitespace-nowrap">
        {formatClockTime(row.last_seen_at)}
      </td>

      {/* App time + mini bar */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="tabular-nums text-xs font-medium text-gray-700 w-14 shrink-0">
            {row.is_active ? formatVisibleTime(row.visible_seconds) : "—"}
          </span>
          {row.is_active && (
            <div className="flex-1 h-1.5 rounded-full bg-gray-100 min-w-[40px]">
              <div
                className="h-full rounded-full bg-blue-400"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      </td>

      {/* Sessions */}
      <td className="px-4 py-3 text-center tabular-nums text-xs text-gray-600">
        {row.is_active ? row.session_count : "—"}
      </td>

      {/* Expenses */}
      <td className="px-4 py-3 text-center tabular-nums text-xs">
        <span className={row.expenses_submitted_count > 0 ? "text-purple-600 font-medium" : "text-gray-400"}>
          {row.expenses_submitted_count}
        </span>
      </td>
    </tr>
  );
}

// ─── Mobile daily log card ────────────────────────────────────────────────────

function DailyLogCard({ row, maxSecs }: { row: TimelineRow; maxSecs: number }) {
  const pct = maxSecs > 0
    ? Math.min(100, Math.round((row.visible_seconds / maxSecs) * 100))
    : 0;

  return (
    <div
      className={`rounded-xl border p-3 ${
        row.is_active
          ? "bg-white border-green-100"
          : "bg-gray-50 border-gray-100"
      }`}
    >
      {/* Date + status */}
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs font-semibold font-mono ${row.is_active ? "text-gray-800" : "text-gray-400"}`}>
          {formatLongDate(row.activity_date)}
        </span>
        {row.is_active ? (
          <span className="text-[11px] font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
            Active
          </span>
        ) : (
          <span className="text-[11px] font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
            Inactive
          </span>
        )}
      </div>

      {row.is_active ? (
        <>
          {/* First / last used */}
          <div className="flex gap-4 text-xs text-gray-500 mb-2">
            <span>
              <span className="text-gray-400">First: </span>
              <span className="text-gray-700 font-medium">{formatClockTime(row.first_seen_at)}</span>
            </span>
            <span>
              <span className="text-gray-400">Last: </span>
              <span className="text-gray-700 font-medium">{formatClockTime(row.last_seen_at)}</span>
            </span>
          </div>

          {/* App time bar */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-blue-700 w-14 shrink-0">
              {formatVisibleTime(row.visible_seconds)}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-blue-400" style={{ width: `${pct}%` }} />
            </div>
          </div>

          {/* Sessions + expenses */}
          <div className="flex gap-4 text-xs text-gray-500">
            <span>
              <span className="text-gray-400">Sessions: </span>
              <span className="text-gray-700 font-medium">{row.session_count}</span>
            </span>
            <span>
              <span className="text-gray-400">Expenses: </span>
              <span className={row.expenses_submitted_count > 0 ? "text-purple-600 font-medium" : "text-gray-700 font-medium"}>
                {row.expenses_submitted_count}
              </span>
            </span>
          </div>
        </>
      ) : (
        <p className="text-xs text-gray-400">No activity recorded this day.</p>
      )}
    </div>
  );
}

// ─── Timeline drawer ──────────────────────────────────────────────────────────

function TimelineDrawer({
  userId,
  userName,
  open,
  onClose,
}: {
  userId: string;
  userName: string;
  open: boolean;
  onClose: () => void;
}) {
  const range = dateRangeFromDays(30);

  const { data: timeline = [], isLoading } = useQuery({
    queryKey: ["user-activity-timeline", userId, range.start, range.end],
    enabled: open && !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_user_activity_timeline", {
        p_user_id:    userId,
        p_start_date: range.start,
        p_end_date:   range.end,
      });
      if (error) throw error;
      return (data ?? []) as TimelineRow[];
    },
    staleTime: 2 * 60_000,
  });

  // Compute drawer summary stats from timeline data
  const activeDays        = timeline.filter(r => r.is_active).length;
  const inactiveDays      = timeline.length - activeDays;
  const totalVisibleSecs  = timeline.reduce((s, r) => s + r.visible_seconds, 0);
  const totalExpenses     = timeline.reduce((s, r) => s + r.expenses_submitted_count, 0);
  const lastUsedRaw       = timeline
    .map(r => r.last_seen_at)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  const maxSecs           = getMaxVisibleSeconds(timeline);
  const sorted            = [...timeline].sort(
    (a, b) => b.activity_date.localeCompare(a.activity_date)
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl w-full max-h-[90vh] flex flex-col p-0 gap-0">

        {/* ── Header ─────────────────────────────────────────────── */}
        <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <DialogTitle className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-blue-500 shrink-0" />
            {userName}
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-500 mt-1">
            Daily activity log · {range.start} → {range.end}
          </DialogDescription>
          <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
            <Eye className="h-3 w-3" />
            Visible app time only. No keystrokes, screenshots, or off-app tracking.
          </p>
        </DialogHeader>

        {/* ── Scrollable body ────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

          {isLoading ? (
            <div className="py-6 px-4">
              <AsyncOperationProgress status="running" title="Loading activity data…" showSuccess={false} compact />
            </div>
          ) : timeline.length === 0 ? (
            <div className="py-12 text-center text-gray-400 text-sm">
              No activity data for this range.
            </div>
          ) : (
            <>
              {/* ── Mini summary cards ─────────────────────────── */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <MiniCard
                  icon={<CalendarDays className="h-4 w-4 text-green-600" />}
                  label="Active days"
                  value={activeDays}
                  color="bg-green-50"
                />
                <MiniCard
                  icon={<TrendingDown className="h-4 w-4 text-orange-500" />}
                  label="Inactive days"
                  value={inactiveDays}
                  color="bg-orange-50"
                />
                <MiniCard
                  icon={<Clock className="h-4 w-4 text-blue-600" />}
                  label="Total app time"
                  value={formatVisibleTime(totalVisibleSecs)}
                  color="bg-blue-50"
                />
                <MiniCard
                  icon={<FileText className="h-4 w-4 text-purple-600" />}
                  label="Expenses submitted"
                  value={totalExpenses}
                  color="bg-purple-50"
                />
                <MiniCard
                  icon={<Activity className="h-4 w-4 text-gray-500" />}
                  label="Last used"
                  value={formatLastSeen(lastUsedRaw)}
                  color="bg-gray-100"
                />
              </div>

              {/* ── Desktop table ─────────────────────────────────── */}
              <div className="hidden sm:block rounded-xl border border-gray-100 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b text-xs text-gray-500 uppercase tracking-wide">
                      <th className="px-4 py-3 text-left font-medium">Date</th>
                      <th className="px-4 py-3 text-left font-medium">Status</th>
                      <th className="px-4 py-3 text-left font-medium">First used</th>
                      <th className="px-4 py-3 text-left font-medium">Last used</th>
                      <th className="px-4 py-3 text-left font-medium">App time</th>
                      <th className="px-4 py-3 text-center font-medium">Sessions</th>
                      <th className="px-4 py-3 text-center font-medium">Expenses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((row) => (
                      <DailyLogRow key={row.activity_date} row={row} maxSecs={maxSecs} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── Mobile card list ──────────────────────────────── */}
              <div className="sm:hidden space-y-2">
                {sorted.map((row) => (
                  <DailyLogCard key={row.activity_date} row={row} maxSecs={maxSecs} />
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type RangeDays = "7" | "30" | "90";
type ActiveFilter = "all" | "active" | "inactive";

export default function UserActivityInsights() {
  const { hasOrganizationFeature } = useAuth();
  const { policy } = useOrganizationIdentityMode();
  const featureEnabled = hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.user_activity_insights);

  const [rangeDays, setRangeDays]       = useState<RangeDays>("30");
  const [searchTerm, setSearchTerm]     = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [selectedUser, setSelectedUser] = useState<{ id: string; name: string } | null>(null);

  const range = dateRangeFromDays(Number(rangeDays));

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ["user-activity-summary", range.start, range.end],
    enabled: featureEnabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_user_activity_summary", {
        p_start_date: range.start,
        p_end_date:   range.end,
      });
      if (error) throw error;
      return (data ?? []) as ActivitySummaryRow[];
    },
    staleTime: 2 * 60_000,
  });

  const filteredRows = rows.filter((r) => {
    const q = searchTerm.toLowerCase();
    const matchSearch =
      !q ||
      r.name.toLowerCase().includes(q) ||
      (policy.includeEmailInSearch && r.email.toLowerCase().includes(q)) ||
      (policy.includeEmployeeIdInSearch && (r.employee_id ?? "").toLowerCase().includes(q)) ||
      (policy.allowSyntheticEmployeeIdFallback &&
        !r.employee_id &&
        (employeeIdFromSyntheticEmail(r.email ?? "") ?? "").toLowerCase().includes(q));

    const trend = getTrendLabel(r);
    const matchFilter =
      activeFilter === "all" ||
      (activeFilter === "active"   && (trend === "Active" || trend === "Stable")) ||
      (activeFilter === "inactive" && trend === "Inactive");

    return matchSearch && matchFilter;
  });

  if (!featureEnabled) return <FeatureDisabledCard />;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Activity className="h-7 w-7 text-blue-600" />
          User Activity Insights
        </h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Activity time is approximate and based on visible PesoWise app sessions.
          It does not track keystrokes, screenshots, or browsing outside PesoWise.
        </p>
      </div>

      {/* Privacy info card */}
      <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-sm space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-800 uppercase tracking-wide">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              What this tracks
            </div>
            <ul className="space-y-0.5 text-xs text-blue-700 list-none pl-0">
              {["Visible PesoWise app time", "Last used time", "Session count", "Expenses submitted per day"].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-blue-400 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              What this does NOT track
            </div>
            <ul className="space-y-0.5 text-xs text-gray-500 list-none pl-0">
              {["Keystrokes", "Screenshots", "Websites or other apps", "Location, camera, microphone"].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-gray-300 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="border-t border-blue-100 pt-2 flex flex-col sm:flex-row gap-2 text-xs text-gray-500">
          <span>
            <strong>Admin responsibility:</strong> This feature is enabled for authorized admins only.
            Users are shown a notice before tracking starts.
          </span>
          <span className="sm:border-l sm:border-blue-100 sm:pl-2">
            <strong>Retention:</strong> Activity data is kept per your organization's configured retention period.
          </span>
          <span className="sm:border-l sm:border-blue-100 sm:pl-2">
            For access, correction, or deletion requests — contact organization admin or see{" "}
            <Link
              to="/legal/data-rights"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              Data Rights &amp; Grievance
            </Link>
            . Full details in the{" "}
            <Link
              to="/legal/activity-insights"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              Activity Insights Notice
            </Link>
            .
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={rangeDays} onValueChange={(v) => setRangeDays(v as RangeDays)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>

        <Select value={activeFilter} onValueChange={(v) => setActiveFilter(v as ActiveFilter)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            <SelectItem value="active">Active / Stable</SelectItem>
            <SelectItem value="inactive">Inactive only</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search name, email, employee ID…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Summary cards */}
      {!isLoading && rows.length > 0 && <SummaryCards rows={rows} />}

      {/* Table */}
      <Card className="border-0 bg-white/80 shadow-xl">
        <CardHeader className="px-4 py-3 border-b">
          <CardTitle className="text-base font-semibold">
            {filteredRows.length} user{filteredRows.length !== 1 ? "s" : ""}
          </CardTitle>
          <CardDescription className="text-xs">
            {range.start} → {range.end} · Click any user to view day-by-day activity logs.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-6 px-4">
              <AsyncOperationProgress status="running" title="Loading activity data…" showSuccess={false} />
            </div>
          ) : error ? (
            <div className="py-12 text-center space-y-1">
              <p className="text-red-500 text-sm font-medium">Activity summary could not be loaded.</p>
              <p className="text-gray-400 text-xs">
                The tracker may still be collecting data. Please refresh or check the summary RPC.
              </p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="py-12 text-center text-gray-400 text-sm">
              No users match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">User</th>
                    <th className="px-4 py-3 text-left font-medium">Role</th>
                    <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Emp. ID</th>
                    <th className="px-4 py-3 text-left font-medium">Last used</th>
                    <th className="px-4 py-3 text-right font-medium">Today app time</th>
                    <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Today expenses</th>
                    <th className="px-4 py-3 text-right font-medium hidden lg:table-cell">Active days</th>
                    <th className="px-4 py-3 text-right font-medium hidden lg:table-cell">Streak</th>
                    <th className="px-4 py-3 text-center font-medium">Trend</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredRows.map((row) => (
                    <tr
                      key={row.user_id}
                      className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                      onClick={() => setSelectedUser({ id: row.user_id, name: row.name || row.email })}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 truncate max-w-[160px]">
                          {row.name || "—"}
                        </div>
                        <div className="text-xs text-gray-400 truncate max-w-[160px]">{row.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-gray-600 capitalize text-xs">{row.role.replace("_", " ")}</span>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-gray-500 text-xs">
                        {row.employee_id || "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">
                        {formatLastSeen(row.last_seen_at)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                        {formatVisibleTime(row.today_visible_seconds)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums hidden md:table-cell text-gray-700">
                        {row.today_expenses_submitted}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums hidden lg:table-cell text-gray-700">
                        {row.active_days} / {row.active_days + row.inactive_days}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums hidden lg:table-cell text-gray-500 text-xs">
                        {row.current_inactive_streak > 0 ? `${row.current_inactive_streak}d` : "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <TrendBadge row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Timeline drawer */}
      {selectedUser && (
        <TimelineDrawer
          userId={selectedUser.id}
          userName={selectedUser.name}
          open={!!selectedUser}
          onClose={() => setSelectedUser(null)}
        />
      )}
    </div>
  );
}
