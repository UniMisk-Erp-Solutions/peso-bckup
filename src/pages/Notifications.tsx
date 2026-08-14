import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Bell, 
  CheckCircle, 
  XCircle, 
  Clock, 
  AlertCircle,
  Eye,
  ArrowRight
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { translateNotificationDisplay } from "@/lib/translateNotification";
import { getDateFnsLocale } from "@/lib/formatLocale";
import { notificationMatchesOrg, userIdRealtimeFilter } from "@/lib/realtimeFilters";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileNotificationsView } from "@/components/mobile/MobileNotificationsView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";

interface Notification {
  id: string;
  type: "expense_submitted" | "expense_approved" | "expense_rejected" | "expense_assigned" | "expense_verified" | "balance_added";
  title: string;
  message: string;
  expense_id: string | null;
  expense_title?: string;
  created_at: string;
  read: boolean;
  actor_name?: string;
}

export default function Notifications() {
  const { t, i18n } = useTranslation(["notifications", "common"]);
  const dateLocale = getDateFnsLocale(i18n.language);
  const { user, userRole, organizationId } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const { isMobile } = useViewportMode();
  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startLoadProgress(t("common:loading"));
    } else if (!loading && wasLoading) {
      completeLoadProgress(t("common:success"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    if (user) {
      fetchNotifications();
      // Set up real-time subscription for new notifications
      const cleanup = setupRealtimeSubscription();
      return cleanup;
    }
  }, [user]);

  const fetchNotifications = async () => {
    try {
      setLoading(true);
      
      if (!organizationId) {
        throw new Error("Organization not found");
      }

      // Fetch notifications from notifications table
      const { data: notificationsData, error: notificationsError } = await supabase
        .from("notifications")
        .select(`
          *,
          expenses(title)
        `)
        .eq("user_id", user?.id)
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false })
        .limit(100);

      if (notificationsError) throw notificationsError;

      // Convert to notification format
      const notificationData = (notificationsData || []).map(notif => ({
        id: notif.id,
        type: notif.type as Notification["type"],
        title: notif.title,
        message: notif.message,
        expense_id: notif.expense_id || "",
        expense_title: notif.expenses?.title || "",
        created_at: notif.created_at,
        read: notif.read,
        actor_name: undefined // Not stored in notifications table
      }));

      setNotifications(notificationData);
      setUnreadCount(notificationData.filter(n => !n.read).length);
    } catch (error) {
      console.error("Error fetching notifications:", error);
      toast({
        variant: "destructive",
        title: t("common:error"),
        description: t("loadFailed"),
      });
    } finally {
      setLoading(false);
    }
  };

  const setupRealtimeSubscription = () => {
    if (!user?.id) return () => {};

    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on('postgres_changes', 
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'notifications',
          filter: userIdRealtimeFilter(user.id)
        }, 
        (payload) => {
          if (!notificationMatchesOrg(payload, organizationId)) return;
          console.log('New notification received in Notifications page:', payload);
          // Handle new notification
          const newNotif = payload.new as any;
          toast({
            title: newNotif.title
              ? translateNotificationDisplay(
                  { type: newNotif.type, title: newNotif.title, message: newNotif.message || "" },
                  t,
                ).title
              : t("newNotification"),
            description: newNotif.message
              ? translateNotificationDisplay(
                  { type: newNotif.type, title: newNotif.title, message: newNotif.message },
                  t,
                ).message
              : t("newNotificationHint"),
          });
          fetchNotifications();
        }
      )
      .on('postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: userIdRealtimeFilter(user.id)
        },
        (payload) => {
          if (!notificationMatchesOrg(payload, organizationId)) return;
          fetchNotifications();
        }
      )
      .subscribe((status) => {
        if (import.meta.env.DEV) {
          console.log('Notifications page subscription status:', status);
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  };

  const getNotificationType = (action: string): Notification["type"] => {
    if (action.includes("submitted")) return "expense_submitted";
    if (action.includes("approved")) return "expense_approved";
    if (action.includes("rejected")) return "expense_rejected";
    if (action.includes("assigned")) return "expense_assigned";
    if (action.includes("verified")) return "expense_verified";
    return "expense_submitted";
  };

  const getNotificationTitle = (action: string): string => {
    if (action.includes("submitted")) return "Expense Submitted";
    if (action.includes("approved")) return "Expense Approved";
    if (action.includes("rejected")) return "Expense Rejected";
    if (action.includes("assigned")) return "Expense Assigned";
    if (action.includes("verified")) return "Expense Verified";
    return "Expense Update";
  };

  const getDefaultMessage = (action: string): string => {
    if (action.includes("submitted")) return "Your expense has been submitted for review";
    if (action.includes("approved")) return "Your expense has been approved";
    if (action.includes("rejected")) return "Your expense has been rejected";
    if (action.includes("assigned")) return "An expense has been assigned to you for review";
    if (action.includes("verified")) return "Your expense has been verified by a manager";
    return "Your expense status has been updated";
  };

  const getNotificationIcon = (type: Notification["type"]) => {
    switch (type) {
      case "expense_approved":
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      case "expense_rejected":
        return <XCircle className="h-5 w-5 text-red-600" />;
      case "expense_submitted":
      case "expense_assigned":
        return <Clock className="h-5 w-5 text-blue-600" />;
      case "expense_verified":
        return <AlertCircle className="h-5 w-5 text-yellow-600" />;
      case "balance_added":
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      default:
        return <Bell className="h-5 w-5 text-gray-600" />;
    }
  };

  const getNotificationBadgeVariant = (type: Notification["type"]) => {
    switch (type) {
      case "expense_approved":
        return "success" as const;
      case "expense_rejected":
        return "destructive" as const;
      case "expense_submitted":
      case "expense_assigned":
        return "default" as const;
      case "expense_verified":
        return "secondary" as const;
      default:
        return "outline" as const;
    }
  };

  const markAsRead = async (notificationId: string) => {
    // Update in database
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("id", notificationId);

    if (!error) {
      setNotifications(prev => 
        prev.map(n => n.id === notificationId ? { ...n, read: true } : n)
      );
      setUnreadCount(prev => Math.max(0, prev - 1));
    }
  };

  const markAllAsRead = async () => {
    if (!user?.id) return;

    // Update all in database
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("user_id", user.id)
      .eq("read", false);

    if (!error) {
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
    }
  };

  const handleNotificationClick = (notification: Notification) => {
    markAsRead(notification.id);
    if (notification.expense_id) {
      navigate(`/expenses/${notification.expense_id}`);
      return;
    }
    if (
      notification.type.startsWith("transfer_offer_")
    ) {
      navigate("/transfer-offers");
    }
  };

  const getRecentNotifications = () => {
    return notifications.slice(0, 10);
  };

  const getNotificationsByType = () => {
    const grouped = notifications.reduce((acc, notification) => {
      if (!acc[notification.type]) {
        acc[notification.type] = [];
      }
      acc[notification.type].push(notification);
      return acc;
    }, {} as Record<string, Notification[]>);

    return grouped;
  };

  if (isMobile) {
    return (
      <MobileNotificationsView
        notifications={notifications}
        loading={loading}
        unreadCount={unreadCount}
        onMarkAsRead={markAsRead}
        onMarkAllAsRead={markAllAsRead}
        onNotificationClick={handleNotificationClick}
        getNotificationIcon={getNotificationIcon}
        getNotificationBadgeVariant={getNotificationBadgeVariant}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground">{t("pageDescription")}</p>
        </div>
        {unreadCount > 0 && (
          <Button variant="outline" onClick={markAllAsRead}>
            {t("markAllRead")}
          </Button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Notifications</CardTitle>
            <Bell className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{notifications.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unread</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{unreadCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Approved</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {notifications.filter(n => n.type === "expense_approved").length}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {notifications.filter(n => ["expense_submitted", "expense_assigned"].includes(n.type)).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Notifications */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Notifications</CardTitle>
          <CardDescription>
            Latest updates on your expense submissions
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadProgress.status !== "idle" && (
            <div className="mb-4">
              <AsyncOperationProgress
                status={loadProgress.status}
                title={loadProgress.phase}
                showSuccess={loadProgress.status === "success"}
                compact={loadProgress.status === "running"}
              />
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : notifications.length === 0 ? (
            <div className="text-center py-8">
              <Bell className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">{t("empty")}</h3>
              <p className="text-muted-foreground">{t("emptyDescription")}</p>
            </div>
          ) : (
            <ScrollArea className="h-96">
              <div className="space-y-3">
                {getRecentNotifications().map((notification) => {
                  const display = translateNotificationDisplay(notification, t);
                  return (
                  <div
                    key={notification.id}
                    className={`flex items-start gap-3 p-4 border rounded-lg hover:bg-muted/50 cursor-pointer transition-colors ${
                      !notification.read ? "bg-blue-50 border-blue-200" : ""
                    }`}
                    onClick={() => handleNotificationClick(notification)}
                  >
                    <div className="flex-shrink-0 mt-1">
                      {getNotificationIcon(notification.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium text-sm">{display.title}</h4>
                        <div className="flex items-center gap-2">
                          <Badge variant={getNotificationBadgeVariant(notification.type)}>
                            {notification.type.replace("expense_", "").replace("_", " ")}
                          </Badge>
                          {!notification.read && (
                            <div className="w-2 h-2 bg-blue-600 rounded-full"></div>
                          )}
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {display.message}
                      </p>
                      <div className="flex items-center justify-between mt-2">
                        {notification.expense_title && (
                          <p className="text-xs text-muted-foreground">
                            {notification.expense_title}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(notification.created_at), "MMM d, h:mm a", {
                            locale: dateLocale,
                          })}
                        </p>
                      </div>
                    </div>
                    {notification.expense_id && (
                      <div className="flex-shrink-0">
                        <Button variant="ghost" size="sm">
                          <Eye className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Notification Types Summary */}
      {notifications.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Notification Summary</CardTitle>
            <CardDescription>
              Breakdown of notifications by type
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {Object.entries(getNotificationsByType()).map(([type, typeNotifications]) => (
                <div key={type} className="space-y-2">
                  <div className="flex items-center gap-2">
                    {getNotificationIcon(type as Notification["type"])}
                    <h4 className="font-medium capitalize">
                      {type.replace("expense_", "").replace("_", " ")}
                    </h4>
                  </div>
                  <div className="text-2xl font-bold">
                    {typeNotifications.length}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {typeNotifications.filter(n => !n.read).length} unread
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
