import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Coins, Clock, CheckCircle, XCircle, TrendingUp, Users, Receipt, Wallet, Bell, CheckCircle as CheckCircleIcon, XCircle as XCircleIcon, AlertCircle, ArrowRight, UserPlus, ArrowLeft } from "lucide-react";
import { formatINR } from "@/lib/format";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAllowCashierExpenseSubmission } from "@/hooks/useAllowCashierExpenseSubmission";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { SubmitExpenseActions } from "@/components/SubmitExpenseActions";
import { translateNotificationDisplay } from "@/lib/translateNotification";
import { getDateFnsLocale } from "@/lib/formatLocale";
import { notificationMatchesOrg } from "@/lib/realtimeFilters";
import { DashboardPendingTransferOffers } from "@/components/DashboardPendingTransferOffers";
import {
  fetchDashboardExpenseSummary,
  fetchEngineerPendingReviewSummary,
  fetchMyTeamsPendingSummary,
  fetchOrgRoleBalanceTotals,
} from "@/lib/dashboardStats";
import {
  hasApprovalHierarchy,
  hasTeamsEnabled,
  isOrganizationFeatureActive,
} from "@/lib/orgFeatureGates";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import {
  dashboardStatsCacheKey,
  readDashboardStatsCache,
  writeDashboardStatsCache,
} from "@/lib/dashboardStatsCache";
import { useDashboardTheme } from "@/hooks/useDashboardTheme";
import { OldMoneyDashboard } from "@/components/dashboard/OldMoneyDashboard";
import { useDashboardBackendHealth } from "@/hooks/useDashboardBackendHealth";

interface DashboardStats {
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

interface Notification {
  id: string;
  type: "expense_submitted" | "expense_approved" | "expense_rejected" | "expense_assigned" | "expense_verified" | "balance_added";
  title: string;
  message: string;
  expense_id: string | null;
  expense_title?: string;
  created_at: string;
  read: boolean;
}

const HEALTH_CHIP_CONFIG = {
  checking:    { label: "Checking…",  classes: "bg-gray-100 text-gray-500 border-gray-200",            dot: "bg-gray-400" },
  healthy:     { label: "Healthy",    classes: "bg-green-50 text-green-700 border-green-200",           dot: "bg-green-500" },
  degraded:    { label: "Degraded",   classes: "bg-yellow-50 text-yellow-700 border-yellow-200",        dot: "bg-yellow-500" },
  unavailable: { label: "Unavailable",classes: "bg-red-50 text-red-600 border-red-200",                dot: "bg-red-500" },
} as const;

function BackendHealthChip({ state, checkedAt }: { state: keyof typeof HEALTH_CHIP_CONFIG; checkedAt: string | null }) {
  const cfg = HEALTH_CHIP_CONFIG[state];
  const lastChecked = checkedAt ? new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div
      title="Diagnostic only. Does not activate maintenance."
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium select-none ${cfg.classes}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot} ${state === "checking" ? "animate-pulse" : ""}`} />
      {cfg.label}
      {lastChecked && <span className="opacity-60 ml-0.5">· {lastChecked}</span>}
    </div>
  );
}

export default function Dashboard() {
  const { t, i18n } = useTranslation("dashboard");
  const { t: tNotif } = useTranslation("notifications");
  const { t: tTransfers } = useTranslation("transfers");
  const dateLocale = getDateFnsLocale(i18n.language);
  const { user, userRole, organizationId, isAccountantCashier, userBalance, refreshBalance, organizationFeatureFlags, isTenantHost, tenantHostOrgId } = useAuth();
  const featureCtx = {
    featureFlags: organizationFeatureFlags,
    isTenantHost,
    tenantHostOrgId,
    organizationId,
  };
  const myTeamsEnabled =
    hasTeamsEnabled(featureCtx) || hasApprovalHierarchy(featureCtx);
  // DOC-087 — employees with the feature on can open their balance credit
  // history from the Current Balance card. The displayed value is unchanged.
  const balanceHistoryEnabled =
    userRole === "employee" &&
    isOrganizationFeatureActive(
      ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
      featureCtx,
    );
  const { allowCashierExpenseSubmission } = useAllowCashierExpenseSubmission();
  const navigate = useNavigate();
  const [dashboardTheme] = useDashboardTheme();
  const backendHealth = useDashboardBackendHealth();
  const dashboardSubscriptionActiveRef = useRef(false);
  const dashboardReconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic token: a slower/older fetchStats() can never overwrite newer stats.
  const statsSeqRef = useRef(0);
  // Collapse bursts of realtime events into a single background refresh.
  const realtimeRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Master admins use the dedicated Master Admin Dashboard
  useEffect(() => {
    if (userRole === "master_admin") {
      navigate("/master", { replace: true });
    }
  }, [userRole, navigate]);

  const [stats, setStats] = useState<DashboardStats>({
    totalExpenses: 0,
    pendingAmount: 0,
    approvedAmount: 0,
    currentBalance: 0,
    pendingReviews: 0,
    pendingReviewsAmount: 0,
    pendingApprovals: 0,
    pendingApprovalsAmount: 0,
    totalEmployeeBalance: 0,
    totalEngineerBalance: 0,
    totalCashierBalance: 0,
  });
  const [loading, setLoading] = useState(true);
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const {
    progress: dashboardProgress,
    startOperation: startDashboardProgress,
    completeOperation: completeDashboardProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);
  const prevRefreshingRef = useRef(false);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startDashboardProgress(t("loading", { defaultValue: "Loading dashboard…" }));
    } else if (!loading && wasLoading) {
      completeDashboardProgress(t("ready", { defaultValue: "Dashboard ready" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [returnMoneyDialogOpen, setReturnMoneyDialogOpen] = useState(false);
  const [returnAmount, setReturnAmount] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [returningMoney, setReturningMoney] = useState(false);
  const [returnRequests, setReturnRequests] = useState<any[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (userRole === "master_admin") return; // redirecting to /master
    if (!user?.id || !userRole) return;

    void fetchNotifications();
    if (userRole === "cashier" && !isAccountantCashier) {
      void fetchReturnRequests();
    }

    const cacheKey = dashboardStatsCacheKey(user.id, userRole, organizationId);
    const cached = readDashboardStatsCache(cacheKey);
    if (cached) {
      setStats((prev) => ({
        ...prev,
        ...cached,
        totalEmployeeBalance: cached.totalEmployeeBalance ?? prev.totalEmployeeBalance,
        totalEngineerBalance: cached.totalEngineerBalance ?? prev.totalEngineerBalance,
        totalCashierBalance: cached.totalCashierBalance ?? prev.totalCashierBalance,
      }));
      setLoading(false);
    }

    if (userRole === "admin" && !organizationId) {
      void fetchStatsPartial({ background: Boolean(cached) });
      return;
    }
    void fetchStats({ background: Boolean(cached) });
  }, [user, userRole, organizationId, isAccountantCashier]);

  const fetchReturnRequests = async () => {
    if (!user?.id || userRole !== "cashier") return;
    try {
      setLoadingRequests(true);
      // Try to import the service, but don't crash if it fails
      try {
        const { MoneyReturnService } = await import("@/services/MoneyReturnService");
        const requests = await MoneyReturnService.getPendingRequests(user.id);
        
        // Fetch requester names for all requests
        const requesterIds = requests.map(r => r.requester_id);
        if (requesterIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, name")
            .in("user_id", requesterIds);
          
          const nameMap = new Map(profiles?.map(p => [p.user_id, p.name]) || []);
          const requestsWithNames = requests.map(r => ({
            ...r,
            requesterName: nameMap.get(r.requester_id) || "Unknown"
          }));
          setReturnRequests(requestsWithNames);
        } else {
          setReturnRequests(requests);
        }
      } catch (importError) {
        // If the service or table doesn't exist yet, just set empty array
        console.warn("MoneyReturnService not available yet:", importError);
        setReturnRequests([]);
      }
    } catch (error) {
      console.error("Error fetching return requests:", error);
      setReturnRequests([]);
    } finally {
      setLoadingRequests(false);
    }
  };

  const handleApproveRequest = async (requestId: string) => {
    if (!user?.id) return;
    try {
      setLoadingRequests(true);
      try {
        const { MoneyReturnService } = await import("@/services/MoneyReturnService");
        await MoneyReturnService.approveReturnRequest(requestId, user.id);
        toast({
          title: "Request Approved",
          description: "Money has been transferred successfully.",
        });
        fetchReturnRequests();
        refreshBalance();
        fetchStats();
      } catch (importError: any) {
        toast({
          variant: "destructive",
          title: "Error",
          description: importError.message || "Service not available. Please ensure the database migration has been run.",
        });
      }
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to approve request.",
      });
    } finally {
      setLoadingRequests(false);
    }
  };

  const handleRejectRequest = async (requestId: string, reason?: string) => {
    if (!user?.id) return;
    try {
      setLoadingRequests(true);
      try {
        const { MoneyReturnService } = await import("@/services/MoneyReturnService");
        await MoneyReturnService.rejectReturnRequest(requestId, user.id, reason);
        toast({
          title: "Request Rejected",
          description: "The return request has been rejected.",
        });
        fetchReturnRequests();
      } catch (importError: any) {
        toast({
          variant: "destructive",
          title: "Error",
          description: importError.message || "Service not available. Please ensure the database migration has been run.",
        });
      }
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to reject request.",
      });
    } finally {
      setLoadingRequests(false);
    }
  };


  useEffect(() => {
    if (!user?.id) return;

    dashboardSubscriptionActiveRef.current = true;

    try {
      const cleanup = setupRealtimeSubscription();

      const pollInterval = setInterval(() => {
        if (!dashboardSubscriptionActiveRef.current) return;
        try {
          fetchNotifications();
        } catch (error) {
          console.warn("Error polling notifications:", error);
        }
      }, 60000);

      // Set up real-time subscription for return requests (cashiers only)
      let requestsCleanup = () => {};
      if (userRole === "cashier") {
        try {
          const requestsChannel = supabase
            .channel(`cashier-return-requests-${user.id}`)
            .on('postgres_changes',
              {
                event: '*',
                schema: 'public',
                table: 'money_return_requests',
                filter: `cashier_id=eq.${user.id}`
              },
              () => {
                console.log('Return request updated, refreshing...');
                fetchReturnRequests();
              }
            )
            .subscribe();
          
          requestsCleanup = () => {
            try {
              supabase.removeChannel(requestsChannel);
            } catch (error) {
              console.warn("Error removing requests channel:", error);
            }
          };
        } catch (error) {
          console.warn("Could not set up return requests subscription:", error);
        }
      }

      return () => {
        dashboardSubscriptionActiveRef.current = false;
        if (dashboardReconnectTimeoutRef.current) {
          clearTimeout(dashboardReconnectTimeoutRef.current);
          dashboardReconnectTimeoutRef.current = null;
        }
        if (realtimeRefreshTimeoutRef.current) {
          clearTimeout(realtimeRefreshTimeoutRef.current);
          realtimeRefreshTimeoutRef.current = null;
        }
        try {
          cleanup();
          clearInterval(pollInterval);
          requestsCleanup();
        } catch (error) {
          console.warn("Error during cleanup:", error);
        }
      };
    } catch (error) {
      console.error("Error setting up dashboard subscriptions:", error);
      // Return empty cleanup function to prevent errors
      return () => {};
    }
  }, [user?.id, userRole]);

  const fetchStatsPartial = async (opts?: { background?: boolean }) => {
    try {
      if (!user?.id) return;
      if (!opts?.background) setLoading(true);
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("balance")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      const nextBalance = profile?.balance ?? 0;
      setStats((prev) => {
        const merged = { ...prev, currentBalance: nextBalance };
        if (user?.id && userRole) {
          writeDashboardStatsCache(
            dashboardStatsCacheKey(user.id, userRole, organizationId),
            merged,
          );
        }
        return merged;
      });
    } catch (error) {
      console.error("Error fetching dashboard balance:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async (opts?: { background?: boolean }) => {
    const seq = ++statsSeqRef.current;
    try {
      if (!user?.id || !userRole) return;
      if (opts?.background) {
        setStatsRefreshing(true);
      } else {
        setLoading(true);
      }

      const isAdmin = userRole === "admin";

      // All independent fetches run in parallel.
      const [profileResult, expenseSummary, pendingReviewResult, roleTotalsResult] =
        await Promise.all([
          supabase.from("profiles").select("balance").eq("user_id", user.id).maybeSingle(),
          fetchDashboardExpenseSummary(supabase, {
            organizationId: isAdmin ? organizationId : null,
            userId: isAdmin ? null : user.id,
          }),
          userRole === "engineer"
            ? myTeamsEnabled && organizationId
              ? fetchMyTeamsPendingSummary(organizationId)
              : fetchEngineerPendingReviewSummary(supabase, user.id)
            : Promise.resolve(null),
          isAdmin && organizationId
            ? fetchOrgRoleBalanceTotals(supabase, organizationId)
            : Promise.resolve(null),
        ]);

      const { data: profile, error: profileError } = profileResult;
      if (profileError) throw profileError;

      let pendingReviews = 0;
      let pendingReviewsAmount = 0;
      if (pendingReviewResult) {
        pendingReviews = pendingReviewResult.count;
        pendingReviewsAmount = pendingReviewResult.amount;
      }

      let totalEmployeeBalance = 0;
      let totalEngineerBalance = 0;
      let totalCashierBalance = 0;
      if (roleTotalsResult) {
        totalEmployeeBalance = roleTotalsResult.employee;
        totalEngineerBalance = roleTotalsResult.engineer;
        totalCashierBalance = roleTotalsResult.cashier;
      }

      const nextStats: DashboardStats = {
        totalExpenses: isAdmin ? expenseSummary.totalAmount : expenseSummary.expenseCount,
        pendingAmount: expenseSummary.pendingAmount,
        approvedAmount: expenseSummary.approvedAmount,
        currentBalance: profile?.balance ?? 0,
        pendingReviews,
        pendingReviewsAmount,
        pendingApprovals: expenseSummary.pendingApprovals,
        pendingApprovalsAmount: expenseSummary.pendingApprovalsAmount,
        totalEmployeeBalance: isAdmin ? totalEmployeeBalance : undefined,
        totalEngineerBalance: isAdmin ? totalEngineerBalance : undefined,
        totalCashierBalance: isAdmin ? totalCashierBalance : undefined,
      };

      if (seq !== statsSeqRef.current) return;
      setStats(nextStats);
      writeDashboardStatsCache(
        dashboardStatsCacheKey(user.id, userRole, organizationId),
        nextStats,
      );
    } catch (error) {
      console.error("Error fetching stats:", error);
    } finally {
      setLoading(false);
      setStatsRefreshing(false);
    }
  };

  const fetchNotifications = async () => {
    try {
      if (!user?.id) return;

      // Fetch 2 most recent notifications
      const { data: notificationsData, error: notificationsError } = await supabase
        .from("notifications")
        .select(`
          *,
          expenses(title)
        `)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(2);

      if (notificationsError) {
        console.error("Error fetching notifications:", notificationsError);
        return;
      }

      // Convert to notification format
      const notificationData = (notificationsData || []).map(notif => ({
        id: notif.id,
        type: notif.type as Notification["type"],
        title: notif.title,
        message: notif.message,
        expense_id: notif.expense_id || null,
        expense_title: notif.expenses?.title || "",
        created_at: notif.created_at,
        read: notif.read,
      }));

      // Only update if notifications actually changed to avoid unnecessary re-renders
      setNotifications(prev => {
        const prevIds = prev.map(n => n.id).sort().join(',');
        const newIds = notificationData.map(n => n.id).sort().join(',');
        if (prevIds !== newIds) {
          console.log('📬 Dashboard: New notifications detected, updating...');
          // Polling can detect balance-related notifications even when realtime
          // profile updates are missed, so refresh balance/stats as a fallback.
          refreshBalance();
          fetchStats({ background: true });
          return notificationData;
        }
        return prev;
      });
    } catch (error) {
      console.error("Error fetching notifications:", error);
    }
  };

  // Debounce realtime-driven refreshes: many notification events in quick
  // succession collapse into one background fetch, and the seq guard in
  // fetchStats ensures the latest result wins (no flicker / revert).
  const scheduleRealtimeRefresh = () => {
    if (realtimeRefreshTimeoutRef.current) return;
    realtimeRefreshTimeoutRef.current = setTimeout(() => {
      realtimeRefreshTimeoutRef.current = null;
      void fetchNotifications();
      void fetchStats({ background: true });
    }, 400);
  };

  const setupRealtimeSubscription = () => {
    if (!user?.id) {
      console.log('No user ID, skipping dashboard subscription');
      return () => {};
    }

    console.log('Setting up dashboard notification subscription for user:', user.id);

    // Remove any existing channel with the same name first
    const channelName = `dashboard-notifications-${user.id}`;
    const existingChannel = supabase.getChannels().find(ch => ch.topic === `realtime:${channelName}`);
    if (existingChannel) {
      console.log('Removing existing dashboard channel:', channelName);
      supabase.removeChannel(existingChannel);
    }

    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', 
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'notifications',
          filter: `user_id=eq.${user.id}`
        }, 
        (payload) => {
          if (organizationId && !notificationMatchesOrg(payload, organizationId)) return;
          console.log('✅ Dashboard: New notification received via realtime:', payload);
          // Immediately update notifications state
          const newNotif = payload.new as any;
          const notification: Notification = {
            id: newNotif.id,
            type: newNotif.type,
            title: newNotif.title,
            message: newNotif.message,
            expense_id: newNotif.expense_id || null,
            created_at: newNotif.created_at,
            read: newNotif.read || false,
          };
          
          setNotifications(prev => {
            // Check if notification already exists
            if (prev.some(n => n.id === notification.id)) {
              return prev;
            }
            // Add new notification at the beginning, keep only 2 most recent
            console.log('📬 Dashboard: Adding new notification to state:', notification);
            return [notification, ...prev].slice(0, 2);
          });
          
          scheduleRealtimeRefresh(); // coalesce: refresh notifications + stats once
        }
      )
      .on('postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`
        },
        (payload) => {
          console.log('Dashboard: Notification updated:', payload);
          scheduleRealtimeRefresh();
        }
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          if (!dashboardSubscriptionActiveRef.current || dashboardReconnectTimeoutRef.current) return;
          dashboardReconnectTimeoutRef.current = setTimeout(() => {
            dashboardReconnectTimeoutRef.current = null;
            if (!dashboardSubscriptionActiveRef.current) return;
            setupRealtimeSubscription();
          }, 10000);
        }
      });

      return () => {
        console.log('Cleaning up dashboard notification subscription');
        supabase.removeChannel(channel);
      };
    };

  const handleReturnMoney = async (overrideAmount?: string, overrideNote?: string) => {
    if (!user || !userRole || userBalance === null) return;

    const amount = parseFloat(overrideAmount ?? returnAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({
        variant: "destructive",
        title: "Invalid Amount",
        description: "Please enter a valid amount greater than 0",
      });
      return;
    }

    if (amount > userBalance) {
      toast({
        variant: "destructive",
        title: "Insufficient Balance",
        description: `You only have ${formatINR(userBalance)}. Cannot return ${formatINR(amount)}`,
      });
      return;
    }

    try {
      setReturningMoney(true);

      // For employees and engineers, find their assigned cashier
      let targetUserId: string | null = null;

      if (userRole === "employee" || userRole === "engineer") {
        // Resolve cashier with multiple fallbacks:
        // 1) explicit assigned_cashier_id on profile
        // 2) RPC get_cashier_for_engineer
        // 3) direct cashier_assigned_engineer_id match
        // 4) location-based cashier_assigned_location_id match
        const { data: requesterProfile, error: requesterProfileError } = await supabase
          .from("profiles")
          .select("assigned_cashier_id, reporting_engineer_id, organization_id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (requesterProfileError) throw requesterProfileError;

        const requesterOrgId = (requesterProfile as any)?.organization_id || null;
        let managerId: string | null =
          userRole === "employee"
            ? ((requesterProfile as any)?.reporting_engineer_id || null)
            : user.id;

        if (userRole === "employee" && !managerId) {
          toast({
            variant: "destructive",
            title: "No Manager Assigned",
            description: "You don't have a manager assigned. Please contact an administrator.",
          });
          setReturningMoney(false);
          return;
        }

        // 1) Profile-level assignment has highest priority
        const assignedCashierId = (requesterProfile as any)?.assigned_cashier_id || null;
        if (assignedCashierId) {
          targetUserId = assignedCashierId;
        }

        // Helper to ensure selected user is an active cashier in the same org
        const pickActiveCashier = async (candidateIds: string[]): Promise<string | null> => {
          if (!candidateIds.length) return null;
          let membershipQuery = supabase
            .from("organization_memberships")
            .select("user_id")
            .in("user_id", candidateIds)
            .eq("role", "cashier")
            .eq("is_active", true);

          if (requesterOrgId) {
            membershipQuery = membershipQuery.eq("organization_id", requesterOrgId);
          }

          const { data: memberships, error: membershipsError } = await membershipQuery;
          if (membershipsError) {
            console.error("Error validating cashier memberships:", membershipsError);
            return null;
          }
          return memberships?.[0]?.user_id || null;
        };

        // 2) Preferred existing RPC flow
        if (!targetUserId && managerId) {
          const { data: cashierUserId, error: cashierError } = await supabase
            .rpc("get_cashier_for_engineer", { engineer_user_id: managerId });

          if (cashierError) {
            console.warn("RPC get_cashier_for_engineer failed, using fallback lookup:", cashierError);
          } else if (cashierUserId) {
            targetUserId = await pickActiveCashier([cashierUserId]) || cashierUserId;
          }
        }

        // 3) Direct assignment fallback
        if (!targetUserId && managerId) {
          let directQuery = supabase
            .from("profiles")
            .select("user_id")
            .eq("cashier_assigned_engineer_id", managerId)
            .limit(10);

          if (requesterOrgId) {
            directQuery = directQuery.eq("organization_id", requesterOrgId);
          }

          const { data: directCashiers, error: directError } = await directQuery;
          if (!directError && directCashiers?.length) {
            targetUserId = await pickActiveCashier(directCashiers.map((c: any) => c.user_id));
          }
        }

        // 4) Location-based fallback
        if (!targetUserId && managerId) {
          const { data: managerLocation } = await supabase
            .from("engineer_locations")
            .select("location_id")
            .eq("engineer_id", managerId)
            .limit(1)
            .maybeSingle();

          const locationId = (managerLocation as any)?.location_id || null;
          if (locationId) {
            let locationQuery = supabase
              .from("profiles")
              .select("user_id")
              .eq("cashier_assigned_location_id", locationId)
              .limit(10);

            if (requesterOrgId) {
              locationQuery = locationQuery.eq("organization_id", requesterOrgId);
            }

            const { data: locationCashiers, error: locationError } = await locationQuery;
            if (!locationError && locationCashiers?.length) {
              targetUserId = await pickActiveCashier(locationCashiers.map((c: any) => c.user_id));
            }
          }
        }

        if (!targetUserId) {
          toast({
            variant: "destructive",
            title: "No Cashier Assigned",
            description: "Could not find an active cashier assignment for your manager. Please contact an administrator.",
          });
          setReturningMoney(false);
          return;
        }
      } else {
        toast({
          variant: "destructive",
          title: "Invalid Operation",
          description: "Return money is only available for employees and engineers.",
        });
        setReturningMoney(false);
        return;
      }

      if (!targetUserId) {
        throw new Error("Target cashier not found");
      }

      // Create a return request (requires cashier approval)
      const { MoneyReturnService } = await import("@/services/MoneyReturnService");
      await MoneyReturnService.createReturnRequest(user.id, targetUserId, amount, overrideNote ?? returnNote);

      // Refresh balance and stats (request doesn't change balance yet)
      void refreshBalance();
      fetchStats();

      // Update local state
      setReturnAmount("");
      setReturnNote("");
      setReturnMoneyDialogOpen(false);

      toast({
        title: "Return Request Submitted",
        description: `Your return request of ${formatINR(amount)} has been sent to your cashier for approval. You will be notified once it's approved.`,
      });
    } catch (error: any) {
      console.error("Error returning money:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to return money. Please try again.",
      });
    } finally {
      setReturningMoney(false);
    }
  };

  const getNotificationIcon = (type: Notification["type"]) => {
    switch (type) {
      case "expense_approved":
      case "balance_added":
        return <CheckCircleIcon className="h-5 w-5 text-green-600" />;
      case "expense_rejected":
        return <XCircleIcon className="h-5 w-5 text-red-600" />;
      case "expense_submitted":
      case "expense_assigned":
        return <Clock className="h-5 w-5 text-blue-600" />;
      case "expense_verified":
        return <AlertCircle className="h-5 w-5 text-yellow-600" />;
      default:
        return <Bell className="h-5 w-5 text-gray-600" />;
    }
  };

  const getNotificationBgColor = (type: Notification["type"]) => {
    switch (type) {
      case "expense_approved":
      case "balance_added":
        return "bg-green-50 border-green-200";
      case "expense_rejected":
        return "bg-red-50 border-red-200";
      case "expense_submitted":
      case "expense_assigned":
        return "bg-blue-50 border-blue-200";
      case "expense_verified":
        return "bg-yellow-50 border-yellow-200";
      default:
        return "bg-white border-gray-200";
    }
  };

  const handleNotificationClick = (notification: Notification) => {
    if (notification.expense_id) {
      navigate(`/expenses/${notification.expense_id}`);
    }
  };

  const statCards: Array<{
    id: string;
    title: string;
    value: string | number;
    icon: any;
    description: string;
    highlight: boolean;
    onClick?: () => void;
  }> = [
    {
      id: "currentBalance",
      title: t("currentBalance"),
      value: formatINR(
        userRole === "admin"
          ? stats.currentBalance
          : (userBalance ?? stats.currentBalance)
      ),
      icon: Wallet,
      description: balanceHistoryEnabled
        ? tTransfers("balanceHistory.viewBalanceHistory")
        : t("availableBalance"),
      highlight: true,
      ...(balanceHistoryEnabled
        ? { onClick: () => navigate("/balance-history") }
        : {}),
    },
    {
      id: "totalExpenses",
      title: t("totalExpenses"),
      value: userRole === "admin" ? formatINR(stats.totalExpenses as number) : stats.totalExpenses,
      icon: Coins,
      description: userRole === "admin" ? t("totalAmountAllExpenses") : t("allTimeExpenses"),
      highlight: false,
    },
    ...(userRole === "engineer" && stats.pendingReviews !== undefined
      ? [
          {
            id: "pendingReviews",
            title: t("pendingReviews"),
            value: stats.pendingReviews,
            icon: Clock,
            description: t("toReview", { amount: formatINR(stats.pendingReviewsAmount || 0) }),
            highlight: stats.pendingReviews > 0,
            onClick: () => navigate("/review"),
          },
        ]
      : []),
    ...(userRole === "admin" && stats.pendingApprovals !== undefined
      ? [
          {
            id: "pendingApprovals",
            title: t("pendingApprovals"),
            value: stats.pendingApprovals,
            icon: Clock,
            description: t("toApprove", { amount: formatINR(stats.pendingApprovalsAmount || 0) }),
            highlight: stats.pendingApprovals > 0,
            onClick: () => navigate("/admin/expenses"),
          },
        ]
      : []),
    {
      id: "pendingAmount",
      title: t("pendingAmount"),
      value: formatINR(stats.pendingAmount),
      icon: Clock,
      description: t("awaitingApproval"),
      highlight: false,
    },
    ...(userRole === "admin" && stats.totalEmployeeBalance !== undefined
      ? [
          {
            id: "totalEmployeeBalance",
            title: t("totalEmployeeBalance"),
            value: formatINR(stats.totalEmployeeBalance),
            icon: Wallet,
            description: t("allEmployees"),
            highlight: true,
          },
        ]
      : []),
    ...(userRole === "admin" && stats.totalEngineerBalance !== undefined
      ? [
          {
            id: "totalManagerBalance",
            title: t("totalManagerBalance"),
            value: formatINR(stats.totalEngineerBalance),
            icon: Wallet,
            description: t("allManagers"),
            highlight: true,
          },
        ]
      : []),
    ...(userRole === "admin" && stats.totalCashierBalance !== undefined
      ? [
          {
            id: "totalCashierBalance",
            title: t("totalCashierBalance"),
            value: formatINR(stats.totalCashierBalance),
            icon: Wallet,
            description: t("allCashiers"),
            highlight: true,
          },
        ]
      : []),
  ];

  // Optional "Old Money" theme owns the entire dashboard surface. Master admins are
  // redirected elsewhere, so this only affects normal roles.
  if (dashboardTheme === "old-money" && userRole !== "master_admin") {
    const omBalance =
      userRole === "cashier" || userRole === "engineer" || userRole === "employee"
        ? (userBalance ?? stats.currentBalance)
        : stats.currentBalance;
    return <OldMoneyDashboard currentBalance={omBalance ?? 0} />;
  }

  if (loading) {
    return (
      <div className="space-y-4 sm:space-y-6 lg:space-y-8">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t("title")}</h1>
            <p className="text-sm sm:text-base text-muted-foreground">{t("subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center justify-center py-8">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          <span className="ml-2 text-gray-600">{t("loading")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6 lg:space-y-8">
      {/* Mobile-optimized Header */}
      <div className="flex flex-col gap-3 sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-bold tracking-tight whitespace-nowrap">{t("title")}</h1>
          <p className="text-xs sm:text-sm md:text-base text-muted-foreground whitespace-nowrap mt-1">
            {t("subtitle")}
            {statsRefreshing ? (
              <span className="ml-2 text-xs text-muted-foreground/80">Updating…</span>
            ) : null}
            {dashboardProgress.status !== "idle" && !statsRefreshing && (
              <span className="block mt-1">
                <AsyncOperationProgress
                  status={dashboardProgress.status}
                  title={dashboardProgress.phase}
                  showSuccess={dashboardProgress.status === "success"}
                  compact
                />
              </span>
            )}
          </p>
        </div>
        {userRole === "admin" && (
          <BackendHealthChip state={backendHealth.state} checkedAt={backendHealth.checkedAt} />
        )}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <SubmitExpenseActions />
            {(userRole === "employee" || userRole === "engineer") && (
              <Button
                onClick={() => setReturnMoneyDialogOpen(true)}
                className="whitespace-nowrap"
                variant="outline"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t("returnMoney")}
              </Button>
            )}
            {userRole === "admin" && (
              <Button 
                onClick={() => {
                  navigate("/admin/users");
                  setTimeout(() => {
                    const element = document.getElementById('create-user-section');
                    if (element) {
                      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                  }, 100);
                }}
                className="whitespace-nowrap"
                variant="outline"
              >
                <UserPlus className="mr-2 h-4 w-4" />
                {t("createUser")}
              </Button>
            )}
            {userRole === "engineer" && (
              <Button 
                onClick={() => navigate("/review")}
                className="whitespace-nowrap"
                variant="outline"
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                {t("approveExpense")}
              </Button>
            )}
            {(userRole === "admin" || userRole === "cashier") && (
              <Button 
                onClick={() => navigate("/balances")}
                className="whitespace-nowrap"
                variant="outline"
              >
                <Wallet className="mr-2 h-4 w-4" />
                {t("addBalance")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Mobile-optimized Stats Grid */}
      <div className="grid gap-3 sm:gap-4 md:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          const isPendingReviews = card.id === "pendingReviews";
          const isPendingApprovals = card.id === "pendingApprovals";
          const isTotalBalance =
            card.id === "totalEmployeeBalance" ||
            card.id === "totalManagerBalance" ||
            card.id === "totalCashierBalance";
          return (
            <Card 
              key={card.id} 
              className={`hover:shadow-md transition-all ${
                card.onClick ? 'cursor-pointer hover:scale-[1.02]' : ''
              } ${
                card.highlight 
                  ? isPendingReviews || isPendingApprovals
                    ? 'border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50'
                    : isTotalBalance
                    ? 'border-2 border-green-200 bg-gradient-to-br from-green-50 to-emerald-50'
                    : 'border-2 border-green-200 bg-gradient-to-br from-green-50 to-emerald-50'
                  : ''
              }`}
              onClick={card.onClick}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 gap-2">
                <CardTitle className={`text-xs sm:text-sm md:text-base font-medium truncate flex-1 min-w-0 ${
                  card.highlight 
                    ? isPendingReviews || isPendingApprovals ? 'text-blue-700' : 'text-green-700'
                    : ''
                }`}>
                  {card.title}
                </CardTitle>
                <Icon 
                  className={`h-4 w-4 sm:h-5 sm:w-5 flex-shrink-0 ml-1 ${
                    card.highlight 
                      ? isPendingReviews || isPendingApprovals ? 'text-blue-600' : 'text-green-600'
                      : 'text-muted-foreground'
                  } ${card.onClick ? 'cursor-pointer' : ''}`}
                  onClick={(e) => {
                    if (card.onClick) {
                      e.stopPropagation();
                      card.onClick();
                    }
                  }}
                />
              </CardHeader>
              <CardContent className="px-3 sm:px-4 md:px-6 pb-3 sm:pb-4 md:pb-6">
                {isTotalBalance ? (
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className={`p-1.5 sm:p-2 rounded-lg flex-shrink-0 ${
                      card.id === "totalEmployeeBalance"
                        ? 'bg-green-100' 
                        : card.id === "totalManagerBalance"
                        ? 'bg-blue-100'
                        : 'bg-purple-100'
                    }`}>
                      <Icon className={`h-4 w-4 sm:h-5 sm:w-5 ${
                        card.id === "totalEmployeeBalance"
                          ? 'text-green-600' 
                          : card.id === "totalManagerBalance"
                          ? 'text-blue-600'
                          : 'text-purple-600'
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <div className={`text-base sm:text-lg md:text-xl lg:text-2xl font-bold whitespace-nowrap overflow-hidden text-ellipsis ${
                        card.id === "totalEmployeeBalance"
                          ? 'text-green-700' 
                          : card.id === "totalManagerBalance"
                          ? 'text-blue-700'
                          : 'text-purple-700'
                      }`}>
                        {card.value}
                      </div>
                      <p className={`text-xs sm:text-sm mt-1 truncate ${
                        card.id === "totalEmployeeBalance"
                          ? 'text-green-600' 
                          : card.id === "totalManagerBalance"
                          ? 'text-blue-600'
                          : 'text-purple-600'
                      }`}>
                        {card.description}
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                <div className={`text-base sm:text-lg md:text-xl lg:text-2xl font-bold whitespace-nowrap overflow-hidden text-ellipsis ${
                  card.highlight 
                    ? isPendingReviews || isPendingApprovals ? 'text-blue-800' : 'text-green-800'
                    : card.id === "currentBalance" && typeof card.value === 'string' && card.value.includes('-')
                    ? 'text-red-600'
                    : ''
                }`}>
                  {card.value}
                </div>
                <p className={`text-xs sm:text-sm mt-1 truncate ${
                  card.highlight 
                    ? isPendingReviews || isPendingApprovals ? 'text-blue-600' : 'text-green-600'
                    : 'text-muted-foreground'
                }`}>
                  {card.description}
                </p>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Live Notifications Section */}
      <Card>
        <CardHeader className="px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6">
          <CardTitle className="text-base sm:text-lg md:text-xl flex items-center gap-2 whitespace-nowrap">
            <Bell className="h-4 w-4 sm:h-5 sm:w-5 flex-shrink-0" />
            {t("liveNotifications")}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm whitespace-nowrap">{t("recentNotificationsDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-4 md:px-6 pb-3 sm:pb-4 md:pb-6">
          {notifications.length === 0 ? (
            <p className="text-xs sm:text-sm text-muted-foreground text-center py-4 whitespace-nowrap">
              {t("noNotificationsYet")}
            </p>
          ) : (
            <div className="space-y-2 sm:space-y-3">
              {notifications.map((notification) => {
                const display = translateNotificationDisplay(notification, tNotif);
                return (
                <Card
                  key={notification.id}
                  className={cn(
                    "cursor-pointer hover:shadow-md transition-all",
                    getNotificationBgColor(notification.type),
                    !notification.read && "ring-2 ring-blue-400"
                  )}
                  onClick={() => handleNotificationClick(notification)}
                >
                  <CardContent className="p-3 sm:p-4">
                    <div className="flex items-start gap-2 sm:gap-3">
                      <div className="flex-shrink-0 mt-0.5">
                        {getNotificationIcon(notification.type)}
                      </div>
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold text-xs sm:text-sm text-gray-900 truncate">
                                {display.title}
                              </h4>
                              {!notification.read && (
                                <span className="h-2 w-2 bg-blue-600 rounded-full flex-shrink-0"></span>
                              )}
                            </div>
                            <p className="text-xs text-gray-600 line-clamp-2">
                              {display.message}
                            </p>
                            <p className="text-xs text-gray-400 mt-1 sm:mt-2 whitespace-nowrap">
                              {format(new Date(notification.created_at), "MMM d, h:mm a", {
                                locale: dateLocale,
                              })}
                            </p>
                          </div>
                          {notification.expense_id && (
                            <ArrowRight className="h-4 w-4 text-gray-400 flex-shrink-0 mt-1" />
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                );
              })}
            </div>
          )}
          {notifications.length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <Button
                variant="link"
                className="p-0 h-auto text-sm w-full justify-center"
                onClick={() => navigate("/notifications")}
              >
                {t("viewAllNotifications")}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mobile-optimized Recent Activity */}
      <Card>
        <CardHeader className="px-4 sm:px-6 pt-4 sm:pt-6">
          <CardTitle className="text-lg sm:text-xl">Recent Activity</CardTitle>
          <CardDescription className="text-sm">Your latest expense submissions</CardDescription>
        </CardHeader>
        <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6">
          <p className="text-sm text-muted-foreground">
            View your recent expenses in the{" "}
            <Button
              variant="link"
              className="p-0 h-auto text-sm"
              onClick={() => navigate("/expenses")}
            >
              My Expenses
            </Button>{" "}
            section.
          </p>
        </CardContent>
      </Card>

      {!isAccountantCashier && <DashboardPendingTransferOffers />}

      {isAccountantCashier && (
        <Card className="border-slate-200">
          <CardHeader className="px-4 sm:px-6 pt-4 sm:pt-6">
            <CardTitle className="text-lg sm:text-xl">{t("accountantWorkspace.title")}</CardTitle>
            <CardDescription className="text-sm">
              {t("accountantWorkspace.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => navigate("/accountant/expenses")}>
              {t("accountantWorkspace.approvedExpenses")}
            </Button>
            <Button variant="outline" onClick={() => navigate("/admin/reports")}>
              {t("accountantWorkspace.reports")}
            </Button>
            <Button variant="outline" onClick={() => navigate("/cash-transfer-history")}>
              {t("accountantWorkspace.transferHistory")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Cashier: Return Money Requests */}
      {userRole === "cashier" && !isAccountantCashier && (
        <Card>
          <CardHeader className="px-4 sm:px-6 pt-4 sm:pt-6">
            <CardTitle className="text-lg sm:text-xl">Pending Return Requests</CardTitle>
            <CardDescription className="text-sm">Approve or reject money return requests from employees and managers</CardDescription>
          </CardHeader>
          <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6">
            {loadingRequests ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                <span className="ml-2 text-sm text-gray-600">Loading requests...</span>
              </div>
            ) : returnRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No pending return requests
              </p>
            ) : (
              <div className="space-y-3">
                {returnRequests.map((request: any) => (
                  <Card key={request.id} className="border-2 border-blue-200">
                    <CardContent className="p-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="font-semibold text-sm text-gray-900 truncate">
                              {request.requesterName || "Unknown"}
                            </h4>
                            <span className="text-xs text-gray-500 whitespace-nowrap">
                              wants to return
                            </span>
                          </div>
                          <p className="text-lg font-bold text-blue-600">
                            {formatINR(Number(request.amount))}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            Requested {format(new Date(request.requested_at), "MMM d, h:mm a")}
                          </p>
                          {request.note ? (
                            <p className="text-xs text-gray-700 mt-2 break-words">
                              Note: {request.note}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const reason = prompt("Enter rejection reason (optional):");
                              handleRejectRequest(request.id, reason || undefined);
                            }}
                            disabled={loadingRequests}
                            className="whitespace-nowrap"
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleApproveRequest(request.id)}
                            disabled={loadingRequests}
                            className="whitespace-nowrap"
                          >
                            <CheckCircle className="h-4 w-4 mr-1" />
                            Approve
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Return Money Dialog */}
      {(userRole === "employee" || userRole === "engineer") && (
        <Dialog open={returnMoneyDialogOpen} onOpenChange={setReturnMoneyDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Return Money</DialogTitle>
              <DialogDescription>
                Return money to your assigned cashier. Your current balance: {formatINR(userBalance ?? 0)}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="returnAmount">Amount to Return</Label>
                <Input
                  id="returnAmount"
                  type="number"
                  placeholder="0.00"
                  value={returnAmount}
                  onChange={(e) => setReturnAmount(e.target.value)}
                  min="0"
                  step="0.01"
                  disabled={returningMoney}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="returnNote">Note (optional)</Label>
                <Textarea
                  id="returnNote"
                  placeholder="Add reason or context for this return"
                  value={returnNote}
                  onChange={(e) => setReturnNote(e.target.value)}
                  disabled={returningMoney}
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setReturnMoneyDialogOpen(false);
                  setReturnAmount("");
                  setReturnNote("");
                }}
                disabled={returningMoney}
              >
                Cancel
              </Button>
              <Button
                onClick={handleReturnMoney}
                disabled={returningMoney || !returnAmount || parseFloat(returnAmount) <= 0}
              >
                {returningMoney ? "Returning..." : "Return Money"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
