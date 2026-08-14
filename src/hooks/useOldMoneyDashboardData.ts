import { useEffect, useState } from "react";
import { startOfMonth, subMonths, format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";

export type OldMoneyTxn = {
  id: string;
  title: string;
  category: string | null;
  total_amount: number;
  status: string | null;
  created_at: string;
};

export type OldMoneyCategory = { name: string; amount: number };
export type OldMoneyMonth = { label: string; submitted: number; approved: number };

export type OldMoneyData = {
  loading: boolean;
  /** Current month total expense amount. */
  monthSpent: number;
  /** Approved (settled) amount this month. */
  monthApproved: number;
  /** Pending amount this month. */
  monthPending: number;
  /** Total expenses this month (count). */
  monthCount: number;
  categories: OldMoneyCategory[];
  months: OldMoneyMonth[];
  recent: OldMoneyTxn[];
  /** ISO date of the most recent expense (last debit to the wallet), or null. */
  lastDebitAt: string | null;
  /** The user's employee ID, when set on their profile. */
  employeeId: string | null;
  /** This month's spend vs last month's, as a percentage (can be negative). */
  deltaPct: number;
  /** Largest single expense amount this month. */
  monthLargest: number;
};

const APPROVED_STATES = new Set(["approved", "paid", "verified", "level_1_verified", "level_2_verified"]);

const EMPTY: OldMoneyData = {
  loading: true,
  monthSpent: 0,
  monthApproved: 0,
  monthPending: 0,
  monthCount: 0,
  categories: [],
  months: [],
  recent: [],
  lastDebitAt: null,
  employeeId: null,
  deltaPct: 0,
  monthLargest: 0,
};

/** Real finance figures for the "Old Money" dashboard, scoped to the signed-in user. */
export function useOldMoneyDashboardData(
  userId: string | undefined,
  organizationId: string | null,
  /** When true, aggregate the whole organization's expenses (admin/org view) instead of just the user's. */
  orgWide = false,
): OldMoneyData {
  const [data, setData] = useState<OldMoneyData>(EMPTY);

  useEffect(() => {
    if (!userId || !organizationId) {
      setData({ ...EMPTY, loading: false });
      return;
    }
    let cancelled = false;

    void (async () => {
      setData((prev) => ({ ...prev, loading: true }));
      const windowStart = startOfMonth(subMonths(new Date(), 4)).toISOString();

      let expensesQuery = supabase
        .from("expenses")
        .select("id, title, total_amount, category, status, created_at")
        .eq("organization_id", organizationId);
      // Org view aggregates everyone; personal view filters to the signed-in user.
      if (!orgWide) expensesQuery = expensesQuery.eq("user_id", userId);

      const [{ data: rows, error }, { data: profile }] = await Promise.all([
        expensesQuery
          .gte("created_at", windowStart)
          .order("created_at", { ascending: false })
          .limit(500),
        supabase
          .from("profiles")
          .select("employee_id")
          .eq("user_id", userId)
          .maybeSingle(),
      ]);

      if (cancelled) return;
      const employeeId = (profile as { employee_id?: string | null } | null)?.employee_id ?? null;
      if (error || !rows) {
        setData({ ...EMPTY, loading: false, employeeId });
        return;
      }

      const monthStart = startOfMonth(new Date()).getTime();
      const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

      // Monthly buckets for the last 5 months (oldest → newest).
      const monthKeys: { key: string; label: string }[] = [];
      for (let i = 4; i >= 0; i -= 1) {
        const d = subMonths(new Date(), i);
        monthKeys.push({ key: format(d, "yyyy-MM"), label: format(d, "MMM") });
      }
      const monthMap = new Map<string, { submitted: number; approved: number }>();
      for (const m of monthKeys) monthMap.set(m.key, { submitted: 0, approved: 0 });

      const categoryMap = new Map<string, number>();
      let monthSpent = 0;
      let monthApproved = 0;
      let monthPending = 0;
      let monthCount = 0;
      let monthLargest = 0;

      for (const r of rows as OldMoneyTxn[]) {
        const amt = num(r.total_amount);
        const created = new Date(r.created_at);
        const key = format(created, "yyyy-MM");
        const bucket = monthMap.get(key);
        if (bucket) {
          bucket.submitted += amt;
          if (r.status && APPROVED_STATES.has(r.status)) bucket.approved += amt;
        }
        if (created.getTime() >= monthStart) {
          monthSpent += amt;
          monthCount += 1;
          if (amt > monthLargest) monthLargest = amt;
          if (r.status && APPROVED_STATES.has(r.status)) monthApproved += amt;
          else monthPending += amt;
          const cat = (r.category || "Other").trim() || "Other";
          categoryMap.set(cat, (categoryMap.get(cat) || 0) + amt);
        }
      }

      const categories = Array.from(categoryMap.entries())
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 6);

      const months = monthKeys.map((m) => ({
        label: m.label,
        submitted: monthMap.get(m.key)?.submitted ?? 0,
        approved: monthMap.get(m.key)?.approved ?? 0,
      }));

      const recent = (rows as OldMoneyTxn[]).slice(0, 6);
      const thisMonthBar = months[months.length - 1]?.submitted ?? 0;
      const lastMonthBar = months[months.length - 2]?.submitted ?? 0;
      const deltaPct = lastMonthBar > 0 ? ((thisMonthBar - lastMonthBar) / lastMonthBar) * 100 : 0;
      setData({
        loading: false,
        monthSpent,
        monthApproved,
        monthPending,
        monthCount,
        categories,
        months,
        recent,
        lastDebitAt: recent[0]?.created_at ?? null,
        employeeId,
        deltaPct,
        monthLargest,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, organizationId, orgWide]);

  return data;
}
