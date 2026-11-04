/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Console audit 2026-10-16 -- repeated `profiles?select=notification_settings` -> HTTP 400.
 * The column did not exist in Production; three components each fetched it on every mount and none
 * latched the failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  isMissingNotificationColumnError,
  isServerNotificationSettingsUnsupported,
  loadNotificationSettings,
  normalizeNotificationSettings,
  peekNotificationSettings,
  resetNotificationSettingsStoreForTests,
  saveNotificationSettings,
  subscribeNotificationSettings,
} from "@/lib/notificationSettings";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));

/** A fake PostgREST client that counts requests. */
function fakeClient(opts: { row?: unknown; selectError?: any; updateError?: any; selectThrows?: boolean } = {}) {
  const calls = { select: 0, update: 0, updated: [] as unknown[] };
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            calls.select += 1;
            if (opts.selectThrows) throw new Error("Failed to fetch");
            if (opts.selectError) return { data: null, error: opts.selectError };
            return { data: opts.row === undefined ? { notification_settings: { popup_enabled: false, sound_enabled: true, desktop_enabled: true } } : opts.row, error: null };
          },
        }),
      }),
      update: (v: unknown) => ({
        eq: async () => {
          calls.update += 1;
          calls.updated.push(v);
          return { error: opts.updateError ?? null };
        },
      }),
    }),
  };
  return { client, calls };
}

const MISSING_COLUMN = { code: "42703", message: "column profiles.notification_settings does not exist" };

beforeEach(() => {
  resetNotificationSettingsStoreForTests();
  localStorage.clear();
});

describe("defaults and normalisation", () => {
  it("defaults are popup on, sound on, desktop off", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({ popup_enabled: true, sound_enabled: true, desktop_enabled: false });
    expect(normalizeNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(normalizeNotificationSettings({ popup_enabled: false })).toEqual({ popup_enabled: false, sound_enabled: true, desktop_enabled: false });
    expect(normalizeNotificationSettings({ popup_enabled: "yes" })).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
  it("peek returns defaults before any load", () => {
    expect(peekNotificationSettings("u1")).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
});

describe("read", () => {
  it("reads the column and keeps a browser copy", async () => {
    const { client, calls } = fakeClient();
    const s = await loadNotificationSettings("u1", client);
    expect(s).toEqual({ popup_enabled: false, sound_enabled: true, desktop_enabled: true });
    expect(calls.select).toBe(1);
    expect(JSON.parse(localStorage.getItem("notification_settings_u1")!)).toEqual(s);
  });

  it("a stored row with the default value works for a user who never changed anything", async () => {
    const { client } = fakeClient({ row: { notification_settings: { popup_enabled: true, sound_enabled: true, desktop_enabled: false } } });
    expect(await loadNotificationSettings("u1", client)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("5 components asking at once share ONE request; later asks use the cache", async () => {
    const { client, calls } = fakeClient();
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => loadNotificationSettings("u1", client)));
    await loadNotificationSettings("u1", client);
    expect(calls.select).toBe(1);
    expect(new Set(all.map((s) => JSON.stringify(s))).size).toBe(1);
  });
});

describe("the missing-column 400 never loops", () => {
  it("recognises the PostgREST error shapes", () => {
    expect(isMissingNotificationColumnError(MISSING_COLUMN)).toBe(true);
    expect(isMissingNotificationColumnError({ code: "PGRST204", message: "x" })).toBe(true);
    expect(isMissingNotificationColumnError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingNotificationColumnError(null)).toBe(false);
  });

  it("a 400 for the missing column is sent ONCE, however many components/users/remounts ask afterwards", async () => {
    const { client, calls } = fakeClient({ selectError: MISSING_COLUMN });
    for (let i = 0; i < 5; i++) await loadNotificationSettings("u1", client);
    await loadNotificationSettings("u2", client);
    expect(calls.select).toBe(1);
    expect(isServerNotificationSettingsUnsupported()).toBe(true);
  });

  it("while unsupported, a save only touches the browser copy and sends no update", async () => {
    const { client, calls } = fakeClient({ selectError: MISSING_COLUMN });
    await loadNotificationSettings("u1", client);
    const r = await saveNotificationSettings("u1", { popup_enabled: false, sound_enabled: false, desktop_enabled: false }, client);
    expect(r.persisted).toBe(false);
    expect(calls.update).toBe(0);
    expect(peekNotificationSettings("u1").popup_enabled).toBe(false);
  });
});

describe("save", () => {
  it("writes the browser copy, the server row, and tells subscribers", async () => {
    const { client, calls } = fakeClient();
    const seen: unknown[] = [];
    subscribeNotificationSettings("u1", (s) => seen.push(s));
    const next = { popup_enabled: false, sound_enabled: false, desktop_enabled: true };
    const r = await saveNotificationSettings("u1", next, client);
    expect(r.persisted).toBe(true);
    expect(calls.updated).toEqual([{ notification_settings: next }]);
    expect(JSON.parse(localStorage.getItem("notification_settings_u1")!)).toEqual(next);
    expect(seen).toEqual([next]);
  });

  it("a failed server save still keeps the user's choice locally and does not latch a non-column error", async () => {
    const { client } = fakeClient({ updateError: { code: "42501", message: "permission denied" } });
    const r = await saveNotificationSettings("u1", { popup_enabled: false, sound_enabled: true, desktop_enabled: false }, client);
    expect(r.persisted).toBe(false);
    expect(peekNotificationSettings("u1").popup_enabled).toBe(false);
    expect(isServerNotificationSettingsUnsupported()).toBe(false);
  });

  it("after a save, a reload (new session) reads the stored value back", async () => {
    const stored = { popup_enabled: false, sound_enabled: true, desktop_enabled: false };
    const first = fakeClient();
    await saveNotificationSettings("u1", stored, first.client);
    resetNotificationSettingsStoreForTests(); // new browser session: memory gone
    const second = fakeClient({ row: { notification_settings: stored } });
    expect(await loadNotificationSettings("u1", second.client)).toEqual(stored);
  });
});

describe("network unavailable", () => {
  it("falls back to the browser copy, then defaults, without throwing and without caching the failure", async () => {
    localStorage.setItem("notification_settings_u1", JSON.stringify({ popup_enabled: false, sound_enabled: true, desktop_enabled: false }));
    const down = fakeClient({ selectThrows: true });
    expect(await loadNotificationSettings("u1", down.client)).toEqual({ popup_enabled: false, sound_enabled: true, desktop_enabled: false });
    expect(await loadNotificationSettings("u9", down.client)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    // not cached: once the network is back the next load reads the server
    const up = fakeClient();
    expect((await loadNotificationSettings("u1", up.client)).desktop_enabled).toBe(true);
    expect(up.calls.select).toBe(1);
  });
});
