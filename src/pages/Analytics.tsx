import { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { formatINR } from "@/lib/format";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Lightbulb, RefreshCw, AlertCircle } from "lucide-react";
import {
  AnalyticsFilterBar,
  type AnalyticsFilters,
  defaultFilters,
  presetToRange,
} from "@/components/analytics/AnalyticsFilterBar";
import { AnalyticsMetricCard } from "@/components/analytics/AnalyticsMetricCard";
import { AnalyticsChartCard } from "@/components/analytics/AnalyticsChartCard";
import { AnalyticsTooltip, formatAxisINR } from "@/components/analytics/AnalyticsTooltip";
import { AnalyticsEmptyState } from "@/components/analytics/AnalyticsEmptyState";
import { useExpenseAnalytics } from "@/hooks/useExpenseAnalytics";
import { type AnalyticsResult } from "@/lib/analytics/expenseAnalytics";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHART_COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6",
  "#06b6d4", "#f97316", "#84cc16", "#ec4899", "#14b8a6",
];

const STATUS_COLORS: Record<string, string> = {
  pending: "#f59e0b",
  approved: "#10b981",
  rejected: "#ef4444",
  draft: "#94a3b8",
  other: "#6366f1",
};

function statusColor(cls: string): string {
  return STATUS_COLORS[cls] ?? "#6366f1";
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapters: convert AnalyticsFilters (UI) → hook args
// ─────────────────────────────────────────────────────────────────────────────

function toHookFilters(f: AnalyticsFilters) {
  return {
    dateFrom: new Date(f.dateFrom + "T00:00:00"),
    dateTo: new Date(f.dateTo + "T23:59:59"),
    dateBasis: f.dateBasis,
    granularity: f.granularity,
    compareEnabled: f.compareEnabled,
    statusFilter: f.statuses,
    categoryFilter: f.categories,
    employeeFilter: f.selectedEmployeeId ?? "",
    destinationFilter: f.selectedDestination ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple mini table for "View data" drawer
// ─────────────────────────────────────────────────────────────────────────────

function DataTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} className="text-left py-1 px-1.5 text-muted-foreground font-medium border-b">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
            {row.map((cell, j) => (
              <td key={j} className="py-1 px-1.5 tabular-nums">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview tab
// ─────────────────────────────────────────────────────────────────────────────

function OverviewTab({
  result,
  loading,
  t,
}: {
  result: AnalyticsResult | null;
  loading: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const kpis = result?.kpis;
  const prev = kpis?.prev ?? null;
  const empty = !loading && !result;

  const trendData = result?.trend ?? [];
  const workflowData = useMemo(() => {
    if (!kpis) return [];
    return [
      { name: t("tooltips.pending"), value: kpis.pendingAmount, count: kpis.pendingCount, color: STATUS_COLORS.pending },
      { name: t("tooltips.approved"), value: kpis.approvedAmount, count: kpis.approvedCount, color: STATUS_COLORS.approved },
      { name: t("tooltips.rejected"), value: kpis.rejectedAmount, count: kpis.rejectedCount, color: STATUS_COLORS.rejected },
    ];
  }, [kpis, t]);

  const approvalRateDisplay = kpis?.finalizedApprovalRate != null
    ? `${(kpis.finalizedApprovalRate * 100).toFixed(1)}%`
    : t("metrics.noDecisions");

  const insights = result?.quickInsights ?? [];

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        <AnalyticsMetricCard
          title={t("metrics.totalSpend")}
          value={loading ? "…" : formatINR(kpis?.totalAmount ?? 0)}
          tooltipText={t("metrics.totalSpendHint")}
          currentRaw={kpis?.totalAmount}
          prevRaw={prev?.totalAmount}
          loading={loading}
          large
        />
        <AnalyticsMetricCard
          title={t("metrics.expenseCount")}
          value={loading ? "…" : String(kpis?.totalCount ?? 0)}
          tooltipText={t("metrics.expenseCountHint")}
          currentRaw={kpis?.totalCount}
          prevRaw={prev?.totalCount}
          loading={loading}
        />
        <AnalyticsMetricCard
          title={t("metrics.avgExpense")}
          value={loading ? "…" : formatINR(kpis?.avgAmount ?? 0)}
          tooltipText={t("metrics.avgExpenseHint")}
          currentRaw={kpis?.avgAmount}
          prevRaw={prev?.avgAmount}
          loading={loading}
        />
        <AnalyticsMetricCard
          title={t("metrics.approvalRate")}
          value={loading ? "…" : approvalRateDisplay}
          tooltipText={t("metrics.approvalRateHint")}
          loading={loading}
        />
        <AnalyticsMetricCard
          title={t("metrics.activeSubmitters")}
          value={loading ? "…" : String(kpis?.activeSubmitters ?? 0)}
          tooltipText={t("metrics.activeSubmittersHint")}
          currentRaw={kpis?.activeSubmitters}
          prevRaw={prev?.activeSubmitters}
          loading={loading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Activity trend — takes 2/3 width on large screens */}
        <div className="lg:col-span-2">
          <AnalyticsChartCard
            title={t("charts.activityOverTime")}
            description={t("charts.activityOverTimeDesc")}
            loading={loading}
            empty={!loading && trendData.length === 0}
            emptyLabel={t("empty.pageDesc")}
            dataTable={
              trendData.length > 0 ? (
                <DataTable
                  columns={[t("tooltips.amount"), t("tooltips.count"), "Period"]}
                  rows={trendData.map((d) => [d.label, formatINR(d.amount), d.count])}
                />
              ) : undefined
            }
          >
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={trendData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="amountGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS[0]} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={CHART_COLORS[0]} stopOpacity={0} />
                  </linearGradient>
                  {result?.kpis.prev && (
                    <linearGradient id="prevAmountGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_COLORS[1]} stopOpacity={0.15} />
                      <stop offset="95%" stopColor={CHART_COLORS[1]} stopOpacity={0} />
                    </linearGradient>
                  )}
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={formatAxisINR}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={55}
                />
                <Tooltip
                  content={
                    <AnalyticsTooltip currency showCount />
                  }
                />
                {result?.kpis.prev && (
                  <Area
                    type="monotone"
                    dataKey="prevAmount"
                    name={t("comparison.prevPeriodLabel")}
                    stroke={CHART_COLORS[1]}
                    strokeDasharray="4 2"
                    fill="url(#prevAmountGrad)"
                    strokeWidth={1.5}
                    dot={false}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="amount"
                  name={t("tooltips.amount")}
                  stroke={CHART_COLORS[0]}
                  fill="url(#amountGrad)"
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </AnalyticsChartCard>
        </div>

        {/* Workflow snapshot */}
        <AnalyticsChartCard
          title={t("charts.workflowSnapshot")}
          description={t("charts.workflowSnapshotDesc")}
          loading={loading}
          empty={!loading && workflowData.every((d) => d.value === 0)}
          emptyLabel={t("empty.pageDesc")}
        >
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={workflowData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={75}
                innerRadius={42}
                paddingAngle={2}
              >
                {workflowData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                content={<AnalyticsTooltip currency showCount />}
              />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 11 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>
      </div>

      {/* Quick insights */}
      {insights.length > 0 && (
        <div className="rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Lightbulb className="h-4 w-4 text-amber-500" />
            <p className="text-sm font-semibold">{t("insights.title")}</p>
          </div>
          <ul className="space-y-1.5">
            {insights.map((insight, i) => (
              <li key={i} className="text-xs text-muted-foreground leading-relaxed">
                • {insight}
              </li>
            ))}
          </ul>
        </div>
      )}

      {empty && (
        <AnalyticsEmptyState
          title={t("empty.pageTitle")}
          description={t("empty.pageDesc")}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend Analysis tab
// ─────────────────────────────────────────────────────────────────────────────

function SpendAnalysisTab({
  result,
  loading,
  t,
}: {
  result: AnalyticsResult | null;
  loading: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const categories = result?.categoryBreakdown ?? [];
  const categoryTrend = result?.categoryTrend ?? [];
  const histogram = result?.amountHistogram ?? [];
  const cumulative = result?.cumulativeSpend ?? [];
  const weekday = result?.weekdayBreakdown ?? [];

  const top5Categories = categories.slice(0, 5);
  const categoryTrendKeys = useMemo(
    () => top5Categories.map((c) => c.category),
    [top5Categories],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Category bar chart */}
        <AnalyticsChartCard
          title={t("charts.spendByCategory")}
          description={t("charts.spendByCategoryDesc")}
          loading={loading}
          empty={!loading && categories.length === 0}
          emptyLabel={t("empty.noCategories")}
          dataTable={
            categories.length > 0 ? (
              <DataTable
                columns={[t("filters.category"), t("tooltips.amount"), "%", t("tooltips.count")]}
                rows={categories.map((c) => [c.category, formatINR(c.amount), `${c.pct.toFixed(1)}%`, c.count])}
              />
            ) : undefined
          }
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={categories}
              layout="vertical"
              margin={{ top: 0, right: 8, left: 4, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
              <XAxis
                type="number"
                tickFormatter={formatAxisINR}
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="category"
                width={90}
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<AnalyticsTooltip currency showCount showPct />} />
              <Bar dataKey="amount" name={t("tooltips.amount")} radius={[0, 3, 3, 0]}>
                {categories.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>

        {/* Category pie */}
        <AnalyticsChartCard
          title={t("charts.categoryShare")}
          description={t("charts.categoryShareDesc")}
          loading={loading}
          empty={!loading && categories.length === 0}
          emptyLabel={t("empty.noCategories")}
        >
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={categories}
                dataKey="amount"
                nameKey="category"
                cx="50%"
                cy="50%"
                outerRadius={80}
                paddingAngle={1}
              >
                {categories.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip content={<AnalyticsTooltip currency showPct />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 10 }} />
            </PieChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>
      </div>

      {/* Category trend over time */}
      {categoryTrendKeys.length > 0 && (
        <AnalyticsChartCard
          title={t("charts.categoryTrend")}
          description={t("charts.categoryTrendDesc")}
          loading={loading}
          empty={!loading && categoryTrend.length === 0}
          emptyLabel={t("empty.noCategories")}
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={categoryTrend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tickFormatter={formatAxisINR} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={55} />
              <Tooltip content={<AnalyticsTooltip currency />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 10 }} />
              {categoryTrendKeys.map((cat, i) => (
                <Line
                  key={cat}
                  type="monotone"
                  dataKey={cat}
                  stroke={CHART_COLORS[i % CHART_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Amount histogram */}
        <AnalyticsChartCard
          title={t("charts.amountDistribution")}
          description={t("charts.amountDistributionDesc")}
          loading={loading}
          empty={!loading && histogram.length === 0}
          emptyLabel={t("empty.pageDesc")}
          dataTable={
            histogram.length > 0 ? (
              <DataTable
                columns={["Range", t("tooltips.count"), t("tooltips.amount")]}
                rows={histogram.map((b) => [b.label, b.count, formatINR(b.amount)])}
              />
            ) : undefined
          }
        >
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={histogram} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnalyticsTooltip currency={false} />} />
              <Bar dataKey="count" name={t("tooltips.count")} fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>

        {/* Cumulative spend */}
        <AnalyticsChartCard
          title={t("charts.cumulativeSpend")}
          description={t("charts.cumulativeSpendDesc")}
          loading={loading}
          empty={!loading && cumulative.length === 0}
          emptyLabel={t("empty.pageDesc")}
        >
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={cumulative} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS[2]} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS[2]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tickFormatter={formatAxisINR} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={55} />
              <Tooltip content={<AnalyticsTooltip currency />} />
              <Area type="monotone" dataKey="cumulative" name={t("charts.cumulativeSpend")} stroke={CHART_COLORS[2]} fill="url(#cumGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>
      </div>

      {/* Weekday */}
      <AnalyticsChartCard
        title={t("charts.spendByWeekday")}
        description={t("charts.spendByWeekdayDesc")}
        loading={loading}
        empty={!loading && weekday.length === 0}
        emptyLabel={t("empty.pageDesc")}
      >
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={weekday} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={formatAxisINR} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={55} />
            <Tooltip content={<AnalyticsTooltip currency showCount />} />
            <Bar dataKey="amount" name={t("tooltips.amount")} fill={CHART_COLORS[4]} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </AnalyticsChartCard>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow tab
// ─────────────────────────────────────────────────────────────────────────────

function WorkflowTab({
  result,
  loading,
  t,
}: {
  result: AnalyticsResult | null;
  loading: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const statuses = result?.statusBreakdown ?? [];
  const aging = result?.pendingAging ?? [];
  const kpis = result?.kpis;

  const outcomeData = useMemo(() => {
    if (!kpis) return [];
    return [
      { name: t("tooltips.approved"), value: kpis.approvedAmount, count: kpis.approvedCount, color: STATUS_COLORS.approved },
      { name: t("tooltips.rejected"), value: kpis.rejectedAmount, count: kpis.rejectedCount, color: STATUS_COLORS.rejected },
    ];
  }, [kpis, t]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Status breakdown */}
        <AnalyticsChartCard
          title={t("charts.statusBreakdown")}
          description={t("charts.statusBreakdownDesc")}
          loading={loading}
          empty={!loading && statuses.length === 0}
          emptyLabel={t("empty.noFinalized")}
          dataTable={
            statuses.length > 0 ? (
              <DataTable
                columns={[t("filters.status"), t("tooltips.count"), t("tooltips.amount"), "%"]}
                rows={statuses.map((s) => [s.status, s.count, formatINR(s.amount), `${s.pct.toFixed(1)}%`])}
              />
            ) : undefined
          }
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={statuses} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
              <XAxis type="number" tickFormatter={formatAxisINR} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="status" width={95} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnalyticsTooltip currency showCount />} />
              <Bar dataKey="amount" name={t("tooltips.amount")} radius={[0, 3, 3, 0]}>
                {statuses.map((s, i) => (
                  <Cell key={i} fill={statusColor(s.statusClass)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>

        {/* Approval outcome */}
        <AnalyticsChartCard
          title={t("charts.approvalOutcome")}
          description={t("charts.approvalOutcomeDesc")}
          loading={loading}
          empty={!loading && outcomeData.every((d) => d.value === 0)}
          emptyLabel={t("empty.noFinalized")}
        >
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={outcomeData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                innerRadius={42}
                paddingAngle={3}
              >
                {outcomeData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<AnalyticsTooltip currency showCount />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>
      </div>

      {/* Pending aging */}
      <AnalyticsChartCard
        title={t("charts.pendingAging")}
        description={t("charts.pendingAgingDesc")}
        loading={loading}
        empty={!loading && aging.every((b) => b.count === 0)}
        emptyLabel={t("empty.noPending")}
        dataTable={
          aging.length > 0 ? (
            <DataTable
              columns={["Age (days)", t("tooltips.count"), t("tooltips.amount"), "%"]}
              rows={aging.map((b) => [b.label, b.count, formatINR(b.amount), `${b.pct.toFixed(1)}%`])}
            />
          ) : undefined
        }
      >
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={aging} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip content={<AnalyticsTooltip currency={false} showCount />} />
            <Bar dataKey="count" name={t("tooltips.count")} fill={CHART_COLORS[3]} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </AnalyticsChartCard>

      {/* KPI row for workflow */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <AnalyticsMetricCard
          title={t("metrics.pendingAmount")}
          value={loading ? "…" : formatINR(kpis?.pendingAmount ?? 0)}
          subtitle={loading ? "" : `${kpis?.pendingCount ?? 0} expenses`}
          tooltipText={t("metrics.pendingAmountHint")}
          loading={loading}
        />
        <AnalyticsMetricCard
          title={t("metrics.approvedAmount")}
          value={loading ? "…" : formatINR(kpis?.approvedAmount ?? 0)}
          subtitle={loading ? "" : `${kpis?.approvedCount ?? 0} expenses`}
          tooltipText={t("metrics.approvedAmountHint")}
          loading={loading}
        />
        <AnalyticsMetricCard
          title={t("metrics.rejectedAmount")}
          value={loading ? "…" : formatINR(kpis?.rejectedAmount ?? 0)}
          subtitle={loading ? "" : `${kpis?.rejectedCount ?? 0} expenses`}
          tooltipText={t("metrics.rejectedAmountHint")}
          loading={loading}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// People & Places tab
// ─────────────────────────────────────────────────────────────────────────────

function PeopleAndPlacesTab({
  result,
  loading,
  isAdmin,
  t,
}: {
  result: AnalyticsResult | null;
  loading: boolean;
  isAdmin: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const destinations = result?.destinationBreakdown ?? [];
  const employees = result?.employeeBreakdown ?? [];
  const topExpenses = result?.topExpenses ?? [];

  return (
    <div className="space-y-4">
      {/* Destinations */}
      <AnalyticsChartCard
        title={t("charts.topDestinations")}
        description={t("charts.topDestinationsDesc")}
        loading={loading}
        empty={!loading && destinations.length === 0}
        emptyLabel={t("empty.noDestinations")}
        dataTable={
          destinations.length > 0 ? (
            <DataTable
              columns={[t("filters.destination"), t("tooltips.amount"), "%", t("tooltips.count")]}
              rows={destinations.map((d) => [d.destination, formatINR(d.amount), `${d.pct.toFixed(1)}%`, d.count])}
            />
          ) : undefined
        }
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={destinations} layout="vertical" margin={{ top: 0, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
            <XAxis type="number" tickFormatter={formatAxisINR} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="destination" width={100} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip content={<AnalyticsTooltip currency showCount showPct />} />
            <Bar dataKey="amount" name={t("tooltips.amount")} fill={CHART_COLORS[5]} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </AnalyticsChartCard>

      {/* Employees (admin only) */}
      {isAdmin && (
        <AnalyticsChartCard
          title={t("charts.topEmployees")}
          description={t("charts.topEmployeesDesc")}
          loading={loading}
          empty={!loading && employees.length === 0}
          emptyLabel={t("empty.noEmployees")}
          dataTable={
            employees.length > 0 ? (
              <DataTable
                columns={["Employee", t("tooltips.amount"), t("tooltips.count"), "Avg"]}
                rows={employees.map((e) => [
                  e.employee_id ? `${e.name} (${e.employee_id})` : e.name,
                  formatINR(e.totalAmount),
                  e.count,
                  formatINR(e.avgAmount),
                ])}
              />
            ) : undefined
          }
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={employees} layout="vertical" margin={{ top: 0, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
              <XAxis type="number" tickFormatter={formatAxisINR} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnalyticsTooltip currency showCount />} />
              <Bar dataKey="totalAmount" name={t("tooltips.amount")} fill={CHART_COLORS[6]} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </AnalyticsChartCard>
      )}

      {/* Highest-value expenses table */}
      {topExpenses.length > 0 && (
        <AnalyticsChartCard
          title={t("charts.highestExpenses")}
          description={t("charts.highestExpensesDesc")}
          loading={loading}
          empty={false}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-2 font-medium text-muted-foreground">Title</th>
                  <th className="text-left py-2 px-2 font-medium text-muted-foreground hidden sm:table-cell">Category</th>
                  <th className="text-left py-2 px-2 font-medium text-muted-foreground hidden md:table-cell">Status</th>
                  <th className="text-right py-2 px-2 font-medium text-muted-foreground">Amount</th>
                </tr>
              </thead>
              <tbody>
                {topExpenses.slice(0, 10).map((e) => (
                  <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-1.5 px-2 max-w-[180px] truncate">{e.title}</td>
                    <td className="py-1.5 px-2 hidden sm:table-cell text-muted-foreground">{e.category ?? "—"}</td>
                    <td className="py-1.5 px-2 hidden md:table-cell">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {e.status}
                      </Badge>
                    </td>
                    <td className="py-1.5 px-2 text-right font-medium tabular-nums">
                      {formatINR(typeof e.total_amount === "string" ? parseFloat(e.total_amount) : (e.total_amount ?? 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AnalyticsChartCard>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function Analytics() {
  const { t } = useTranslation("analytics");
  const { user, userRole, organizationId } = useAuth();

  const isAdmin = userRole === "admin";

  const [filters, setFilters] = useState<AnalyticsFilters>(defaultFilters);

  const hookFilters = useMemo(() => toHookFilters(filters), [filters]);

  const { result, meta, refetch } = useExpenseAnalytics(
    organizationId ?? "",
    userRole ?? "employee",
    user?.id,
    hookFilters,
  );

  const loading = meta.isLoading;
  const refreshing = meta.isFetching && !meta.isLoading;

  // Build available filter options from result (or previous stale result)
  const availableCategories = useMemo(
    () => (result?.categoryBreakdown ?? []).map((c) => c.category).filter(Boolean),
    [result],
  );
  const availableDestinations = useMemo(
    () =>
      (result?.destinationBreakdown ?? [])
        .map((d) => d.destination)
        .filter((d) => d && d !== t("filters.unspecified")),
    [result, t],
  );
  const availableEmployees = useMemo(
    () =>
      (result?.employeeBreakdown ?? []).map((e) => ({
        user_id: e.user_id,
        name: e.name,
        employee_id: e.employee_id,
      })),
    [result],
  );

  const handleFiltersChange = useCallback((f: AnalyticsFilters) => setFilters(f), []);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold tracking-tight">{t("page.title")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t("page.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          {refreshing && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin" />
              {t("loading.refreshing")}
            </span>
          )}
          {meta.isError && !loading && (
            <span className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {t("errors.loadFailed")}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => refetch()}
            disabled={loading}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            {t("errors.retry")}
          </Button>
        </div>
      </div>

      {/* Loading progress */}
      {loading && meta.totalFetched > 0 && (
        <div className="text-xs text-muted-foreground">
          {t("loading.loadedCount", { loaded: meta.totalFetched, total: "?" })}
        </div>
      )}

      {/* Filter bar */}
      <div className="rounded-lg border bg-card p-3">
        <AnalyticsFilterBar
          filters={filters}
          onChange={handleFiltersChange}
          availableCategories={availableCategories}
          availableDestinations={availableDestinations}
          availableEmployees={isAdmin ? availableEmployees : []}
          isAdmin={isAdmin}
          disabled={loading}
        />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList className="mb-1">
          <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
          <TabsTrigger value="spendAnalysis">{t("tabs.spendAnalysis")}</TabsTrigger>
          <TabsTrigger value="workflow">{t("tabs.workflow")}</TabsTrigger>
          <TabsTrigger value="peopleAndPlaces">{t("tabs.peopleAndPlaces")}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab result={result} loading={loading} t={t} />
        </TabsContent>
        <TabsContent value="spendAnalysis">
          <SpendAnalysisTab result={result} loading={loading} t={t} />
        </TabsContent>
        <TabsContent value="workflow">
          <WorkflowTab result={result} loading={loading} t={t} />
        </TabsContent>
        <TabsContent value="peopleAndPlaces">
          <PeopleAndPlacesTab result={result} loading={loading} isAdmin={isAdmin} t={t} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
