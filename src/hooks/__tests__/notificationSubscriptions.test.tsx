/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Console audit 2026-10-16 -- "Setting up / Cleaning up / Setting up dashboard notification
 * subscription". The hooks must hold exactly ONE live realtime channel per user/context, rebuild it
 * only when the user or organization really changes, and remove it on unmount.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";

const live = new Map<string, any>(); // topic -> channel (what the server would see as subscribed)
const created: string[] = [];
const removed: string[] = [];

function makeChannel(name: string) {
  const ch: any = { topic: `realtime:${name}` };
  ch.on = () => ch;
  ch.subscribe = () => ch;
  created.push(name);
  live.set(ch.topic, ch);
  return ch;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: (name: string) => makeChannel(name),
    removeChannel: (ch: any) => {
      removed.push(ch.topic.replace("realtime:", ""));
      live.delete(ch.topic);
    },
    getChannels: () => [...live.values()],
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }), then: undefined }), maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}));

let authState: { user: { id: string } | null; organizationId: string | null } = { user: { id: "u1" }, organizationId: "o1" };
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => authState }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/NotificationPopup", () => ({ NotificationPopup: () => null }));
vi.mock("@/lib/realtimeFilters", () => ({ notificationMatchesOrg: () => true, userIdRealtimeFilter: (id: string) => `user_id=eq.${id}` }));

import { useNotificationManager } from "@/hooks/useNotificationManager";
import { useUnreadNotifications } from "@/hooks/useUnreadNotifications";
import { resetNotificationSettingsStoreForTests } from "@/lib/notificationSettings";

beforeEach(() => {
  live.clear();
  created.length = 0;
  removed.length = 0;
  authState = { user: { id: "u1" }, organizationId: "o1" };
  resetNotificationSettingsStoreForTests();
  localStorage.clear();
});

describe.each([
  ["useNotificationManager", () => useNotificationManager(), "notification-popups-u1-o1", "notification-popups-u2-o1"],
  ["useUnreadNotifications", () => useUnreadNotifications(), "unread-notifications-count-u1", "unread-notifications-count-u2"],
])("%s", (_name, hook, channelU1, channelU2) => {
  it("opens exactly one channel for the user and does not rebuild it on re-render", () => {
    const { rerender } = renderHook(hook as () => unknown);
    rerender();
    rerender();
    rerender();
    expect(created.filter((c) => c === channelU1)).toHaveLength(1);
    expect(live.size).toBe(1);
  });

  it("removes the channel on unmount", () => {
    const { unmount } = renderHook(hook as () => unknown);
    unmount();
    expect(live.size).toBe(0);
    expect(removed).toContain(channelU1);
  });

  it("switching user removes the old channel and opens exactly one new one (never two live at once)", () => {
    const { rerender } = renderHook(hook as () => unknown);
    authState = { user: { id: "u2" }, organizationId: "o1" };
    rerender();
    expect(removed).toContain(channelU1);
    expect(created).toContain(channelU2);
    expect(live.size).toBe(1);
    expect([...live.keys()]).toEqual([`realtime:${channelU2}`]);
  });

  it("does nothing until both user and organization are known", () => {
    authState = { user: { id: "u1" }, organizationId: null };
    renderHook(hook as () => unknown);
    expect(created).toHaveLength(0);
  });
});

describe("Dashboard notification channel lifecycle (source guards)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/Dashboard.tsx"), "utf-8").replace(/\r\n/g, "\n");

  it("the notification subscription effect is keyed by (user, organization), NOT by the late-resolving userRole", () => {
    const i = src.indexOf("setupRealtimeSubscription();\n\n      const pollInterval");
    const end = src.indexOf("}, [", i);
    expect(src.slice(end, end + 40)).toContain("}, [user?.id, organizationId]);");
    expect(src.slice(i, end)).not.toContain("userRole");
  });

  it("the cashier channel is a separate effect keyed by (user, isCashier)", () => {
    expect(src).toContain('const isCashier = userRole === "cashier";');
    expect(src).toContain("}, [user?.id, isCashier]);");
  });

  it("a reconnect cannot leak a channel: cleanup removes whichever channel is current via a ref", () => {
    expect(src).toContain("const dashboardChannelRef = useRef<");
    expect(src).toContain("const current = dashboardChannelRef.current;");
    expect(src).toContain("dashboardChannelRef.current = channel;");
  });
});

describe("the realtime handlers read CURRENT preferences", () => {
  const src = readFileSync(resolve(process.cwd(), "src/hooks/useNotificationManager.ts"), "utf-8").replace(/\r\n/g, "\n");
  it("uses a settings ref instead of the first render's closure, and never queries profiles itself", () => {
    expect(src).toContain("settingsRef.current = settings;");
    expect(src).toContain("settingsRef.current.popup_enabled");
    expect(src).not.toMatch(/settings\.popup_enabled/);
    expect(src).not.toContain('.from("profiles")');
  });
});
