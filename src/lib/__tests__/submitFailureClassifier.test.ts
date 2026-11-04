import { describe, expect, it } from "vitest";
import {
  friendlySubmitFailureMessage,
  isConnectionDropError,
  isServerSlowError,
  isUnknownOutcomeError,
} from "@/lib/submitFailureMessages";

const e = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

describe("connection-drop classifier is narrow (PWA first-submit incident)", () => {
  it.each([
    "TypeError: Failed to fetch",
    "Load failed", // iOS Safari / PWA
    "NetworkError when attempting to fetch resource.",
    "The network connection was lost.",
    "Failed to send a request to the Edge Function",
  ])("%s is a genuine connection drop (unknown outcome)", (m) => {
    expect(isConnectionDropError(e(m))).toBe(true);
    expect(isUnknownOutcomeError(e(m))).toBe(true);
    expect(friendlySubmitFailureMessage(e(m), { draftPreserved: true })).toMatch(/connection dropped/);
  });

  it("a database statement timeout is a SLOW SERVER, not a dropped connection", () => {
    const err = e("canceling statement due to statement timeout", { code: "57014" });
    expect(isConnectionDropError(err)).toBe(false);
    expect(isServerSlowError(err)).toBe(true);
    expect(friendlySubmitFailureMessage(err, { draftPreserved: true })).toMatch(/server took too long/i);
    expect(friendlySubmitFailureMessage(err, { draftPreserved: true })).not.toMatch(/connection dropped/);
  });

  it.each([502, 503, 504])("gateway %i is a slow/unavailable server", (status) => {
    expect(isServerSlowError(e("Bad", { status }))).toBe(true);
    expect(isConnectionDropError(e("Failed to fetch", { status }))).toBe(false);
  });

  it.each([
    ["bill validation", "Bill photos are required for expenses above ₹499.", { code: "23514" }],
    ["unique violation", "duplicate key value violates unique constraint", { code: "23505" }],
    ["RLS", "new row violates row-level security policy", { code: "42501" }],
    ["PostgREST error", "JSON object requested, multiple (or no) rows returned", { code: "PGRST116" }],
    ["date lock", "This date is locked", { code: "PW010" }],
    ["validation", "Title is required", {}],
    ["finalization", "Failed to attach uploaded bill photos. Please re-upload and try again.", {}],
    ["still draft", "The expense is still a draft after submitting.", {}],
  ])("%s is NOT a connection drop and NOT auto-retried", (_n, msg, extra) => {
    expect(isConnectionDropError(e(msg as string, extra as Record<string, unknown>))).toBe(false);
    expect(isUnknownOutcomeError(e(msg as string, extra as Record<string, unknown>))).toBe(false);
  });

  it("a Failed-to-fetch message that carries a real HTTP status or SQLSTATE is not a drop", () => {
    expect(isConnectionDropError(e("Failed to fetch", { status: 500 }))).toBe(false);
    expect(isConnectionDropError(e("Failed to fetch", { code: "42P01" }))).toBe(false);
  });

  it("AbortError and auth errors are not connection drops", () => {
    expect(isConnectionDropError(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }))).toBe(false);
    expect(isConnectionDropError(e("JWT expired"))).toBe(false);
    expect(friendlySubmitFailureMessage(e("JWT expired"), { draftPreserved: true })).toMatch(/session expired/i);
  });
});
