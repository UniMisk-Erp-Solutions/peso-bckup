import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  loadNotificationSettings,
  peekNotificationSettings,
  saveNotificationSettings,
  subscribeNotificationSettings,
  type NotificationSettings,
} from "@/lib/notificationSettings";

/**
 * The signed-in user's notification preferences. Every consumer shares one load and one copy
 * (see src/lib/notificationSettings.ts), so mounting several components never multiplies requests.
 */
export function useNotificationSettings() {
  const { user } = useAuth();
  const userId = user?.id;
  const [settings, setSettings] = useState<NotificationSettings>(() => peekNotificationSettings(userId));
  const [loading, setLoading] = useState<boolean>(Boolean(userId));

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setSettings(peekNotificationSettings(userId));
    setLoading(true);
    void loadNotificationSettings(userId).then((s) => {
      if (cancelled) return;
      setSettings(s);
      setLoading(false);
    });
    const unsubscribe = subscribeNotificationSettings(userId, (s) => {
      if (!cancelled) setSettings(s);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);

  const update = useCallback(
    async (next: NotificationSettings) => {
      if (!userId) return { persisted: false };
      return saveNotificationSettings(userId, next);
    },
    [userId],
  );

  return { settings, loading, update };
}
