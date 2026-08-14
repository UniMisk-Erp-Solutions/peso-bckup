import { useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { X, CheckCircle, XCircle, Clock, AlertCircle, Bell, Coins } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { translateNotificationDisplay } from "@/lib/translateNotification";
import { getDateFnsLocale } from "@/lib/formatLocale";

interface NotificationPopupProps {
  id: string;
  type:
    | "expense_submitted"
    | "expense_approved"
    | "expense_rejected"
    | "expense_assigned"
    | "expense_verified"
    | "balance_added"
    | "transfer_offer_received"
    | "transfer_offer_accepted"
    | "transfer_offer_rejected"
    | "transfer_offer_cancelled";
  title: string;
  message: string;
  expenseId: string | null;
  createdAt: string;
  onClose: () => void;
  onView?: () => void;
}

export function NotificationPopup({
  id,
  type,
  title,
  message,
  expenseId,
  createdAt,
  onClose,
  onView,
}: NotificationPopupProps) {
  const { t, i18n } = useTranslation("notifications");
  const navigate = useNavigate();
  const display = translateNotificationDisplay({ type, title, message }, t);
  const dateLocale = getDateFnsLocale(i18n.language);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);

    const timer = setTimeout(() => {
      handleClose();
    }, 5000);

    return () => clearTimeout(timer);
  }, []);

  const handleClose = () => {
    setIsVisible(false);
    setTimeout(() => {
      onClose();
    }, 300);
  };

  const handleClick = () => {
    if (type.startsWith("transfer_offer")) {
      navigate("/transfer-offers");
    } else if (expenseId && onView) {
      onView();
      navigate(`/expenses/${expenseId}`);
    } else {
      navigate("/notifications");
    }
    handleClose();
  };

  const getIcon = () => {
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
      case "transfer_offer_received":
        return <Coins className="h-5 w-5 text-amber-600" />;
      case "transfer_offer_accepted":
        return <Coins className="h-5 w-5 text-green-600" />;
      case "transfer_offer_rejected":
        return <XCircle className="h-5 w-5 text-red-600" />;
      case "transfer_offer_cancelled":
        return <Bell className="h-5 w-5 text-slate-500" />;
      default:
        return <Bell className="h-5 w-5 text-gray-600" />;
    }
  };

  const getBgColor = () => {
    switch (type) {
      case "expense_approved":
      case "balance_added":
      case "transfer_offer_accepted":
        return "bg-green-50 border-green-200";
      case "expense_rejected":
      case "transfer_offer_rejected":
        return "bg-red-50 border-red-200";
      case "expense_submitted":
      case "expense_assigned":
        return "bg-blue-50 border-blue-200";
      case "expense_verified":
        return "bg-yellow-50 border-yellow-200";
      case "transfer_offer_received":
        return "bg-amber-50 border-amber-200";
      case "transfer_offer_cancelled":
        return "bg-slate-50 border-slate-200";
      default:
        return "bg-white border-gray-200";
    }
  };

  return (
    <div
      className={cn(
        "transition-all duration-300 ease-in-out",
        isVisible ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"
      )}
      style={{ maxWidth: "400px", minWidth: "320px" }}
    >
      <Card
        className={cn(
          "shadow-lg border-2 cursor-pointer hover:shadow-xl transition-shadow",
          getBgColor()
        )}
        onClick={handleClick}
      >
        <div className="p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">{getIcon()}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-sm text-gray-900 truncate">
                    {display.title}
                  </h4>
                  <p className="text-xs text-gray-600 mt-1 line-clamp-2">
                    {display.message}
                  </p>
                  <p className="text-xs text-gray-400 mt-2">
                    {format(new Date(createdAt), "h:mm a", { locale: dateLocale })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 flex-shrink-0"
                  aria-label={t("popup.close")}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClose();
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
