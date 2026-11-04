/**
 * Notification preferences (popup / sound / desktop), shared by the Settings page, the
 * Notification Settings page and the realtime notification manager.
 *
 * Why this module exists (console audit 2026-10-16): three components each issued their own
 * `profiles?select=notification_settings`, the column did not exist in Production (HTTP 400), and
 * nothing latched the failure, so the same failing request was sent again on every mount. Now:
 *   - ONE shared load per user (in-flight de-duplication + cache), never one per component;
 *   - a missing column / schema-cache 400 is recognised once and never retried this page load;
 *   - preferences fall back to the browser copy when the server is unreachable;
 *   - the three consumers always agree on the defaults.
 */
import { supabase } from "@/integrations/supabase/client";

export type NotificationSettings = {
  popup_enabled: boolean;
  sound_enabled: boolean;
  desktop_enabled: boolean;
};

export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> = Object.freeze({
  popup_enabled: true,
  sound_enabled: true,
  desktop_enabled: false,
});

type ClientLike = { from: (table: string) => any };

const localKey = (userId: string) => `notification_settings_${userId}`;

export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    popup_enabled: typeof o.popup_enabled === "boolean" ? o.popup_enabled : DEFAULT_NOTIFICATION_SETTINGS.popup_enabled,
    sound_enabled: typeof o.sound_enabled === "boolean" ? o.sound_enabled : DEFAULT_NOTIFICATION_SETTINGS.sound_enabled,
    desktop_enabled: typeof o.desktop_enabled === "boolean" ? o.desktop_enabled : DEFAULT_NOTIFICATION_SETTINGS.desktop_enabled,
  };
}

function readLocal(userId: string): NotificationSettings | null {
  try {
    const raw = localStorage.getItem(localKey(userId));
    return raw ? normalizeNotificationSettings(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocal(userId: string, s: NotificationSettings): void {
  try {
    localStorage.setItem(localKey(userId), JSON.stringify(s));
  } catch {
    /* storage unavailable: the in-memory copy still works */
  }
}

/** PostgREST answers 400 / 42703 (or PGRST204) when the column is not in its schema. */
export function isMissingNotificationColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return code === "42703" || code === "PGRST204" || (msg.includes("notification_settings") && msg.includes("column"));
}

/** Latched for the page load once the server told us the column is not there. */
let serverColumnUnsupported = false;
const cache = new Map<string, NotificationSettings>();
const inflight = new Map<string, Promise<NotificationSettings>>();
const listeners = new Map<string, Set<(s: NotificationSettings) => void>>();

export function resetNotificationSettingsStoreForTests(): void {
  serverColumnUnsupported = false;
  cache.clear();
  inflight.clear();
  listeners.clear();
}

export function isServerNotificationSettingsUnsupported(): boolean {
  return serverColumnUnsupported;
}

function emit(userId: string, s: NotificationSettings) {
  listeners.get(userId)?.forEach((fn) => fn(s));
}

export function subscribeNotificationSettings(userId: string, fn: (s: NotificationSettings) => void): () => void {
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(userId);
  };
}

/** Settings already known without a request (memory, else the browser copy, else defaults). */
export function peekNotificationSettings(userId: string | undefined | null): NotificationSettings {
  if (!userId) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  return cache.get(userId) ?? readLocal(userId) ?? { ...DEFAULT_NOTIFICATION_SETTINGS };
}

/** One logical load per user: concurrent callers share the same request; a loaded user is not refetched. */
export function loadNotificationSettings(userId: string, client: ClientLike = supabase as unknown as ClientLike): Promise<NotificationSettings> {
  const cached = cache.get(userId);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(userId);
  if (running) return running;

  const p = (async (): Promise<NotificationSettings> => {
    const fallback = readLocal(userId) ?? { ...DEFAULT_NOTIFICATION_SETTINGS };
    if (serverColumnUnsupported) {
      cache.set(userId, fallback);
      return fallback;
    }
    try {
      const { data, error } = await client.from("profiles").select("notification_settings").eq("user_id", userId).maybeSingle();
      if (error) {
        if (isMissingNotificationColumnError(error)) serverColumnUnsupported = true;
        // Unknown/transient failure: use the browser copy now, but do NOT cache, so a later mount may retry once.
        if (!serverColumnUnsupported) return fallback;
        cache.set(userId, fallback);
        return fallback;
      }
      const loaded = data?.notification_settings ? normalizeNotificationSettings(data.notification_settings) : fallback;
      writeLocal(userId, loaded);
      cache.set(userId, loaded);
      return loaded;
    } catch {
      return fallback; // network unavailable: browser copy, not cached
    }
  })().finally(() => {
    inflight.delete(userId);
  });
  inflight.set(userId, p);
  return p;
}

/** Saves to the browser copy immediately, then to the profile row. Returns whether the server stored it. */
export async function saveNotificationSettings(
  userId: string,
  next: NotificationSettings,
  client: ClientLike = supabase as unknown as ClientLike,
): Promise<{ persisted: boolean }> {
  const normalized = normalizeNotificationSettings(next);
  cache.set(userId, normalized);
  writeLocal(userId, normalized);
  emit(userId, normalized);
  if (serverColumnUnsupported) return { persisted: false };
  try {
    const { error } = await client.from("profiles").update({ notification_settings: normalized }).eq("user_id", userId);
    if (error) {
      if (isMissingNotificationColumnError(error)) serverColumnUnsupported = true;
      return { persisted: false };
    }
    return { persisted: true };
  } catch {
    return { persisted: false };
  }
}
