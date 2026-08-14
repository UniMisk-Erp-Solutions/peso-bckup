import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Bell,
  Plus,
  RotateCcw,
  ClipboardCheck,
  Check,
  X,
  Building2,
} from "lucide-react";
import { format } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { formatINR } from "@/lib/format";
import { DashboardPendingTransferOffers } from "@/components/DashboardPendingTransferOffers";

interface MobileDashboardStats {
  totalExpenses: number;
  pendingAmount: number;
  approvedAmount: number;
  currentBalance: number;
  pendingReviews?: number;
  pendingReviewsAmount?: number;
  pendingApprovals?: number;
  pendingApprovalsAmount?: number;
  totalEmployeeBalance?: number;
  totalEngineerBalance?: number;
  totalCashierBalance?: number;
}

interface MobileNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  expense_id: string | null;
  created_at: string;
  read: boolean;
}

interface Props {
  stats: MobileDashboardStats;
  loading: boolean;
  statsRefreshing: boolean;
  notifications: MobileNotification[];
  userRole: string | null | undefined;
  userBalance: number | null | undefined;
  isAccountantCashier: boolean;
  allowCashierExpenseSubmission: boolean | null | undefined;
  returnRequests?: any[];
  loadingRequests?: boolean;
  onApproveRequest?: (id: string) => void;
  onRejectRequest?: (id: string, reason?: string) => void;
  onReturnMoney?: (amount: string, note: string) => void;
  returningMoney?: boolean;
}

const REVIEWER_ROLES = new Set(["engineer", "team_leader", "executive"]);

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-28 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
      <Skeleton className="h-12 w-full rounded-xl" />
    </div>
  );
}

export function MobileDashboardView({
  stats,
  loading,
  statsRefreshing,
  notifications,
  userRole,
  userBalance,
  isAccountantCashier,
  allowCashierExpenseSubmission,
  returnRequests,
  loadingRequests,
  onApproveRequest,
  onRejectRequest,
  onReturnMoney,
  returningMoney,
}: Props) {
  const navigate = useNavigate();
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnAmt, setReturnAmt] = useState("");
  const [returnNoteLocal, setReturnNoteLocal] = useState("");

  // Close return drawer when the submission completes (returning flips false)
  const prevReturning = useRef(false);
  useEffect(() => {
    if (prevReturning.current && !returningMoney) {
      setReturnOpen(false);
      setReturnAmt("");
      setReturnNoteLocal("");
    }
    prevReturning.current = !!returningMoney;
  }, [returningMoney]);

  const isAdmin = userRole === "admin";
  const isCashier = userRole === "cashier";
  const isReviewer = REVIEWER_ROLES.has(userRole ?? "");
  const canReturnMoney =
    (userRole === "employee" || userRole === "engineer") && !isAccountantCashier;

  const balance =
    isCashier || isReviewer || userRole === "employee"
      ? (userBalance ?? stats.currentBalance)
      : stats.currentBalance;

  const canSubmit =
    userRole !== "master_admin" &&
    !(isAccountantCashier && !allowCashierExpenseSubmission);

  if (loading) return <DashboardSkeleton />;

  const hasOrgBalances =
    isAdmin &&
    ((stats.totalEmployeeBalance ?? 0) > 0 ||
      (stats.totalEngineerBalance ?? 0) > 0 ||
      (stats.totalCashierBalance ?? 0) > 0);

  const pendingApprovals = stats.pendingApprovals ?? 0;
  const pendingReviews = stats.pendingReviews ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Balance card */}
      <div className="rounded-2xl bg-primary text-primary-foreground px-5 py-4 flex flex-col gap-1 relative overflow-hidden">
        {statsRefreshing && (
          <span className="absolute top-3 right-4 text-xs text-primary-foreground/60 animate-pulse">
            updating…
          </span>
        )}
        <span className="text-xs font-medium text-primary-foreground/70 uppercase tracking-wide">
          Balance
        </span>
        <span className="text-3xl font-bold tracking-tight tabular-nums">
          {formatINR(balance ?? 0)}
        </span>
      </div>

      {/* ── Admin: pending approvals CTA ────────────────────────────────── */}
      {isAdmin && (
        <>
          {pendingApprovals > 0 ? (
            <button
              type="button"
              onClick={() => navigate("/admin/expenses")}
              className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3 flex items-center justify-between gap-2 active:scale-[0.99] transition-transform text-left"
            >
              <div className="flex items-center gap-2">
                <ClipboardCheck className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {pendingApprovals}{" "}
                    {pendingApprovals === 1 ? "approval" : "approvals"} pending
                  </p>
                  {(stats.pendingApprovalsAmount ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {formatINR(stats.pendingApprovalsAmount!)}
                    </p>
                  )}
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          ) : (
            <div className="rounded-xl bg-card border border-border px-4 py-3 flex items-center gap-2 text-muted-foreground">
              <ClipboardCheck className="h-4 w-4 shrink-0" />
              <span className="text-sm">No pending approvals</span>
            </div>
          )}

          {/* Org-wide balances */}
          {hasOrgBalances && (
            <div className="rounded-xl bg-card border border-border px-4 py-3 flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" />
                Organisation Balances
              </div>
              <div className="grid grid-cols-3 gap-2 mt-0.5">
                {(stats.totalEmployeeBalance ?? 0) > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Employee
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatINR(stats.totalEmployeeBalance!)}
                    </span>
                  </div>
                )}
                {(stats.totalEngineerBalance ?? 0) > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Manager
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatINR(stats.totalEngineerBalance!)}
                    </span>
                  </div>
                )}
                {(stats.totalCashierBalance ?? 0) > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Cashier
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatINR(stats.totalCashierBalance!)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Reviewer: pending reviews CTA ──────────────────────────────── */}
      {isReviewer && pendingReviews > 0 && (
        <button
          type="button"
          onClick={() => navigate("/review")}
          className="rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-4 py-3 flex items-center justify-between gap-2 active:scale-[0.99] transition-transform text-left"
        >
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                {pendingReviews} {pendingReviews === 1 ? "review" : "reviews"} pending
              </p>
              {(stats.pendingReviewsAmount ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  {formatINR(stats.pendingReviewsAmount!)}
                </p>
              )}
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </button>
      )}

      {/* ── Regular stats grid (non-admin) ─────────────────────────────── */}
      {!isAdmin && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-card border border-border px-4 py-3 flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Pending amount</span>
            <span className="text-base font-semibold tabular-nums">
              {formatINR(stats.pendingAmount)}
            </span>
            <span className="text-xs text-muted-foreground">
              {stats.totalExpenses}{" "}
              {stats.totalExpenses === 1 ? "expense" : "expenses"}
            </span>
          </div>
          <div className="rounded-xl bg-card border border-border px-4 py-3 flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Approved amount</span>
            <span className="text-base font-semibold tabular-nums">
              {formatINR(stats.approvedAmount)}
            </span>
          </div>
        </div>
      )}

      {/* ── Admin: all-expenses stat grid ──────────────────────────────── */}
      {isAdmin && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-card border border-border px-4 py-3 flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Total expenses</span>
            <span className="text-base font-semibold tabular-nums">
              {formatINR(stats.totalExpenses)}
            </span>
          </div>
          <div className="rounded-xl bg-card border border-border px-4 py-3 flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Pending amount</span>
            <span className="text-base font-semibold tabular-nums">
              {formatINR(stats.pendingAmount)}
            </span>
          </div>
        </div>
      )}

      {/* ── New expense button ──────────────────────────────────────────── */}
      {canSubmit && (
        <button
          type="button"
          className="flex items-center justify-center gap-2 h-12 rounded-xl bg-primary text-primary-foreground font-medium text-sm mobile-fab-shadow active:scale-[0.98] transition-transform"
          onClick={() => navigate("/expenses/new")}
        >
          <Plus className="h-4 w-4" />
          New Expense
        </button>
      )}

      {/* ── Transfer offers (cashier, non-accountant) ───────────────────── */}
      {isCashier && !isAccountantCashier && <DashboardPendingTransferOffers />}

      {/* ── Return requests (cashier, non-accountant) ───────────────────── */}
      {isCashier && !isAccountantCashier && (returnRequests ?? []).length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Return Requests</span>
          <div className="flex flex-col gap-2">
            {(returnRequests ?? []).map((req: any) => (
              <div
                key={req.id}
                className="rounded-xl bg-card border border-border px-4 py-3 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {req.requester_name || "Employee"}
                    </p>
                    <p className="text-base font-semibold tabular-nums">
                      {formatINR(req.amount)}
                    </p>
                    {req.note && (
                      <p className="text-xs text-muted-foreground truncate">{req.note}</p>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onApproveRequest?.(req.id)}
                      disabled={loadingRequests}
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-400 disabled:opacity-50"
                      aria-label="Approve"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRejectRequest?.(req.id)}
                      disabled={loadingRequests}
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-400 disabled:opacity-50"
                      aria-label="Reject"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Return money (employee / engineer) ─────────────────────────── */}
      {canReturnMoney && onReturnMoney && (
        <>
          <button
            type="button"
            onClick={() => setReturnOpen(true)}
            className="flex items-center justify-center gap-2 h-12 rounded-xl bg-secondary text-secondary-foreground font-medium text-sm active:scale-[0.98] transition-transform"
          >
            <RotateCcw className="h-4 w-4" />
            Return Money
          </button>

          <Drawer open={returnOpen} onOpenChange={setReturnOpen} shouldScaleBackground={false}>
            <DrawerContent>
              <DrawerHeader className="pb-2">
                <DrawerTitle>Return Money</DrawerTitle>
                <p className="text-xs text-muted-foreground">
                  Return to your assigned cashier. Balance:{" "}
                  {formatINR(userBalance ?? 0)}
                </p>
              </DrawerHeader>
              <div className="px-4 flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="mobile-return-amount" className="text-sm font-medium">
                    Amount
                  </label>
                  <input
                    id="mobile-return-amount"
                    type="number"
                    inputMode="decimal"
                    value={returnAmt}
                    onChange={(e) => setReturnAmt(e.target.value)}
                    placeholder="Enter amount"
                    disabled={returningMoney}
                    className="h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="mobile-return-note" className="text-sm font-medium">
                    Note{" "}
                    <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <textarea
                    id="mobile-return-note"
                    rows={2}
                    value={returnNoteLocal}
                    onChange={(e) => setReturnNoteLocal(e.target.value)}
                    placeholder="Reason for returning…"
                    disabled={returningMoney}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 resize-none"
                  />
                </div>
              </div>
              <DrawerFooter className="pt-3">
                <button
                  type="button"
                  onClick={() => onReturnMoney(returnAmt, returnNoteLocal)}
                  disabled={
                    returningMoney ||
                    !returnAmt ||
                    parseFloat(returnAmt) <= 0
                  }
                  className="h-11 rounded-xl bg-primary text-primary-foreground font-medium text-sm disabled:opacity-50 active:scale-[0.98] transition-transform"
                >
                  {returningMoney ? "Submitting…" : "Submit Request"}
                </button>
                <button
                  type="button"
                  onClick={() => setReturnOpen(false)}
                  disabled={returningMoney}
                  className="h-11 rounded-xl bg-secondary text-secondary-foreground font-medium text-sm disabled:opacity-50"
                >
                  Cancel
                </button>
              </DrawerFooter>
              <div aria-hidden style={{ height: "env(safe-area-inset-bottom, 0px)" }} />
            </DrawerContent>
          </Drawer>
        </>
      )}

      {/* ── Notifications ───────────────────────────────────────────────── */}
      {notifications.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <Bell className="h-4 w-4" />
              Recent Notifications
            </span>
            <button
              type="button"
              className="text-xs text-primary flex items-center gap-0.5"
              onClick={() => navigate("/notifications")}
            >
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {notifications.slice(0, 2).map((n) => (
              <button
                key={n.id}
                type="button"
                className="w-full text-left bg-card border border-border rounded-xl px-4 py-3 flex flex-col gap-0.5 active:scale-[0.99] transition-transform"
                onClick={() => n.expense_id && navigate(`/expenses/${n.expense_id}`)}
              >
                <span className="text-xs font-medium text-foreground truncate">{n.title}</span>
                <span className="text-xs text-muted-foreground truncate">{n.message}</span>
                <span className="text-xs text-muted-foreground">
                  {format(new Date(n.created_at), "dd MMM, h:mm a")}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── My Expenses quick-link row ───────────────────────────────────── */}
      <button
        type="button"
        onClick={() =>
          navigate(isAdmin ? "/admin/expenses" : "/expenses")
        }
        className="flex items-center justify-between px-4 py-3 rounded-xl bg-card border border-border text-sm font-medium text-foreground active:scale-[0.99] transition-transform"
      >
        <span>{isAdmin ? "All Expenses" : "My Expenses"}</span>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
      </button>
    </div>
  );
}
