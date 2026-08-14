import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { NotificationPopup } from "@/components/NotificationPopup";
import { useNavigate } from "react-router-dom";
import { notificationMatchesOrg, userIdRealtimeFilter } from "@/lib/realtimeFilters";

interface Notification {
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
  expense_id: string | null;
  created_at: string;
}

interface NotificationSettings {
  popup_enabled: boolean;
  sound_enabled: boolean;
  desktop_enabled: boolean;
}

export function useNotificationManager() {
  const { user, organizationId } = useAuth();
  const navigate = useNavigate();
  const [activeNotifications, setActiveNotifications] = useState<Notification[]>([]);
  const [settings, setSettings] = useState<NotificationSettings>({
    popup_enabled: true,
    sound_enabled: true,
    desktop_enabled: false,
  });
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isSettingUpRef = useRef(false);
  const subscriptionActiveRef = useRef(false);

  const logDebug = (...args: unknown[]) => {
    if (import.meta.env.DEV) console.log(...args);
  };

  useEffect(() => {
    if (user) {
      loadSettings();
      // Request notification permission on mount
      requestNotificationPermission();
    }
  }, [user]);

  const requestNotificationPermission = async () => {
    if ("Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch (error) {
        console.error("Error requesting notification permission:", error);
      }
    }
  };

  useEffect(() => {
    if (!user?.id || !organizationId) return;

    subscriptionActiveRef.current = true;
    reconnectAttemptsRef.current = 0;
    logDebug('🔄 Initializing notification subscription...');
    const cleanup = setupRealtimeSubscription();
    
    // Also set up a polling fallback in case realtime doesn't work
    // This will check for new notifications every 10 seconds as a backup
    const pollInterval = setInterval(async () => {
      if (!subscriptionActiveRef.current) return;
      try {
        if (!organizationId) return;

        await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", user.id)
          .eq("organization_id", organizationId)
          .eq("read", false)
          .limit(1);
      } catch (err) {
        console.error("Error polling notifications:", err);
      }
    }, 60000);

    return () => {
      subscriptionActiveRef.current = false;
      cleanup();
      clearInterval(pollInterval);
      isSettingUpRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [user?.id, organizationId]);

  const loadSettings = () => {
    try {
      const stored = localStorage.getItem(`notification_settings_${user?.id}`);
      if (stored) {
        setSettings(JSON.parse(stored));
      } else {
        // Default to enabled for Windows notifications
        setSettings({
          popup_enabled: true,
          sound_enabled: true,
          desktop_enabled: true,
        });
      }
    } catch (error) {
      console.error("Error loading notification settings:", error);
    }
  };

  const playNotificationSound = () => {
    if (settings.sound_enabled) {
      // Create a simple notification sound
      const audio = new Audio("data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIGWi77+efTRAMUKfj8LZjHAY4kdfyzHksBSR3x/DdkEAKFF606euoVRQKRp/g8r5sIQUrgc7y2Yk2CBhou+/nn00QDFCn4/C2YxwGOJHX8sx5LAUkd8fw3ZBAC");
      audio.volume = 0.3;
      audio.play().catch(() => {
        // Ignore errors if audio can't play
      });
    }
  };

  const showDesktopNotification = (notification: Notification) => {
    // Check if browser supports notifications
    if (!("Notification" in window)) {
      console.log("This browser does not support desktop notifications");
      return;
    }

    // Check permission
    if (Notification.permission === "granted") {
      try {
        const desktopNotif = new Notification(notification.title, {
          body: notification.message,
          icon: window.location.origin + "/HERO.png",
          badge: window.location.origin + "/HERO.png",
          tag: notification.id,
          requireInteraction: false,
          silent: !settings.sound_enabled,
          timestamp: new Date(notification.created_at).getTime(),
          dir: "ltr",
        });

        // Make notification clickable - navigate to expense if available
        desktopNotif.onclick = (event) => {
          event.preventDefault();
          window.focus();
          if (notification.expense_id) {
            navigate(`/expenses/${notification.expense_id}`);
          } else {
            navigate("/notifications");
          }
          desktopNotif.close();
        };

        // Auto-close after 5 seconds
        setTimeout(() => {
          desktopNotif.close();
        }, 5000);
      } catch (error) {
        console.error("Error showing desktop notification:", error);
      }
    } else if (Notification.permission === "default") {
      // Request permission if not yet asked
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") {
          // Retry showing notification
          showDesktopNotification(notification);
        }
      });
    } else {
      console.log("Notification permission denied");
    }
  };

  const setupRealtimeSubscription = () => {
    if (!user?.id || !organizationId) {
      return () => {};
    }
    if (isSettingUpRef.current) {
      return () => {};
    }
    isSettingUpRef.current = true;

    logDebug('Setting up notification subscription for user:', user.id);

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const channelName = `notification-popups-${user.id}-${organizationId}`;
    const existingChannel = supabase.getChannels().find(ch => ch.topic === `realtime:${channelName}`);
    if (existingChannel) {
      supabase.removeChannel(existingChannel);
    }

    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', 
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'notifications',
          filter: userIdRealtimeFilter(user.id),
        }, 
        (payload) => {
          if (!notificationMatchesOrg(payload, organizationId)) return;
          logDebug('✅ New notification received via realtime:', payload);
          const newNotif = payload.new as any;
          const notification: Notification = {
            id: newNotif.id,
            type: newNotif.type,
            title: newNotif.title,
            message: newNotif.message,
            expense_id: newNotif.expense_id,
            created_at: newNotif.created_at,
          };

          // Show popup if enabled
          if (settings.popup_enabled) {
            console.log('Adding notification to active notifications:', notification);
            setActiveNotifications(prev => {
              // Check if notification already exists to avoid duplicates
              if (prev.some(n => n.id === notification.id)) {
                return prev;
              }
              return [...prev, notification];
            });
          }

          // Play sound if enabled
          playNotificationSound();

          // Show native Windows desktop notification (like WhatsApp) if enabled
          // This appears in Windows notification center
          if (settings.desktop_enabled) {
            showDesktopNotification(notification);
          }
        }
      )
      .on('postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: userIdRealtimeFilter(user.id),
        },
        (payload) => {
          if (!notificationMatchesOrg(payload, organizationId)) return;
          logDebug('Notification updated:', payload);
        }
      )
      .subscribe((status) => {
        logDebug('📡 Notification subscription status:', status);
        if (status === 'SUBSCRIBED') {
          isSettingUpRef.current = false;
          reconnectAttemptsRef.current = 0;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          isSettingUpRef.current = false;
          if (!subscriptionActiveRef.current || reconnectTimeoutRef.current) return;
          reconnectAttemptsRef.current += 1;
          if (reconnectAttemptsRef.current > 5) {
            logDebug('Notification realtime paused after repeated errors; using polling fallback.');
            return;
          }
          const delayMs = Math.min(8000 * reconnectAttemptsRef.current, 60000);
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            if (!subscriptionActiveRef.current) return;
            setupRealtimeSubscription();
          }, delayMs);
        }
      });

    return () => {
      isSettingUpRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      supabase.removeChannel(channel);
    };
  };

  const removeNotification = useCallback((id: string) => {
    setActiveNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const handleViewNotification = useCallback(
    (expenseId: string | null, type?: string) => {
      if (type?.startsWith("transfer_offer")) {
        navigate("/transfer-offers");
      } else if (expenseId) {
        navigate(`/expenses/${expenseId}`);
      } else {
        navigate("/notifications");
      }
    },
    [navigate],
  );

  return {
    activeNotifications,
    removeNotification,
    handleViewNotification,
  };
}

