import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";

type NotificationType =
  | "expense_submitted"
  | "expense_approved"
  | "expense_rejected"
  | "expense_assigned"
  | "expense_verified"
  | "balance_added";

export interface MobileNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  expense_id: string | null;
  expense_title?: string;
  created_at: string;
  read: boolean;
  actor_name?: string;
}

interface Props {
  notifications: MobileNotification[];
  loading: boolean;
  unreadCount: number;
  onMarkAsRead: (id: string) => void;
  onMarkAllAsRead: () => void;
  onNotificationClick: (notification: MobileNotification) => void;
  getNotificationIcon: (type: NotificationType) => React.ReactNode;
  getNotificationBadgeVariant: (type: NotificationType) => string;
}

export function MobileNotificationsView({
  notifications,
  loading,
  unreadCount,
  onMarkAsRead,
  onMarkAllAsRead,
  onNotificationClick,
  getNotificationIcon,
  getNotificationBadgeVariant,
}: Props) {
  const { t } = useTranslation("notifications");

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b bg-background sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold">
            {t("title", { defaultValue: "Notifications" })}
          </span>
          {unreadCount > 0 && (
            <Badge variant="destructive" className="text-xs h-5 px-1.5">
              {unreadCount}
            </Badge>
          )}
        </div>
        {unreadCount > 0 && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onMarkAllAsRead}>
            <CheckCheck className="h-3.5 w-3.5 mr-1" />
            {t("markAllRead", { defaultValue: "Mark all read" })}
          </Button>
        )}
      </div>

      <div className="divide-y">
        {loading ? (
          <div className="flex justify-center items-center py-10">
            <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        ) : notifications.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2"
            data-testid="notifications-empty"
          >
            <Bell className="h-10 w-10 opacity-30" />
            <p className="text-sm">
              {t("noNotifications", { defaultValue: "No notifications" })}
            </p>
          </div>
        ) : (
          notifications.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`w-full text-left px-4 py-3 transition-colors ${
                n.read
                  ? "bg-background hover:bg-muted/50"
                  : "bg-blue-50 dark:bg-blue-950/20 hover:bg-blue-100/80"
              }`}
              data-testid="notification-item"
              onClick={() => onNotificationClick(n)}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 flex-shrink-0 rounded-full p-1.5 ${
                    n.read ? "bg-muted" : "bg-primary/10"
                  }`}
                >
                  {getNotificationIcon(n.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium truncate">{n.title}</p>
                    {!n.read && (
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-500 flex-shrink-0" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                    {n.message}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap mt-1.5">
                    <Badge
                      variant={getNotificationBadgeVariant(n.type) as "default" | "secondary" | "destructive" | "outline"}
                      className="text-xs h-4 px-1"
                    >
                      {n.type.replace(/_/g, " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(n.created_at), "MMM d, h:mm a")}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
