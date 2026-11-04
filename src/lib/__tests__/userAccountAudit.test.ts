/**
 * DOC-158: pure client-side rules of the user-account audit history.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  AUDIT_EVENT_LABELS, AUDIT_SOURCE_LABELS, auditEventLabel, auditSourceLabel, describeActor, formatAuditValue,
  identityChangeNeedsWarning, isPasswordEvent,
} from "@/lib/userAccountAudit";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261031100000_user_account_audit_history_v1.sql"), "utf-8");

function checkList(column: "event_type" | "source"): string[] {
  const m = migration.match(new RegExp(`${column}\\s+text NOT NULL CHECK \\(${column} IN \\(([\\s\\S]*?)\\)\\)`));
  if (!m) throw new Error(`CHECK list for ${column} not found`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe("name + email reassignment warning rule", () => {
  const base = { oldName: "Krish Patel", oldEmail: "krish@patidartravels.com" };
  it("warns when BOTH the name and the login email change", () => {
    expect(identityChangeNeedsWarning({ ...base, newName: "Dakshit Prajapati", newEmail: "dakshit@patidartravels.com" })).toBe(true);
  });
  it("does not warn for a name-only or an email-only correction", () => {
    expect(identityChangeNeedsWarning({ ...base, newName: "Krish P Patel", newEmail: base.oldEmail })).toBe(false);
    expect(identityChangeNeedsWarning({ ...base, newName: base.oldName, newEmail: "krish.patel@patidartravels.com" })).toBe(false);
  });
  it("ignores case and surrounding whitespace (no false warning for a cosmetic edit)", () => {
    expect(identityChangeNeedsWarning({ ...base, newName: "  krish patel ", newEmail: " KRISH@patidartravels.com " })).toBe(false);
  });
  it("does not warn when nothing changed", () => {
    expect(identityChangeNeedsWarning({ ...base, newName: base.oldName, newEmail: base.oldEmail })).toBe(false);
  });
});

describe("label tables stay in lock-step with the database CHECK lists", () => {
  it("every event type the database allows has a human label", () => {
    const missing = checkList("event_type").filter((k) => !(k in AUDIT_EVENT_LABELS));
    expect(missing).toEqual([]);
  });
  it("every source the database allows has a human label", () => {
    const missing = checkList("source").filter((k) => !(k in AUDIT_SOURCE_LABELS));
    expect(missing).toEqual([]);
  });
  it("no label refers to something the database cannot store", () => {
    const events = new Set(checkList("event_type"));
    expect(Object.keys(AUDIT_EVENT_LABELS).filter((k) => !events.has(k))).toEqual([]);
  });
  it("unknown values degrade to readable text instead of crashing", () => {
    expect(auditEventLabel("some_future_event")).toBe("some future event");
    expect(auditSourceLabel("some_source")).toBe("some source");
  });
});

describe("credentials never reach the screen", () => {
  it.each(["password_changed", "admin_password_reset", "password_reset_requested", "password_reset_completed", "password_reset_failed"])(
    "%s is a password event and renders no value even if a value were present",
    (t) => {
      expect(isPasswordEvent(t)).toBe(true);
      expect(formatAuditValue(t, "hunter2")).toBe("");
      expect(formatAuditValue(t, { password: "hunter2" })).toBe("");
    },
  );
  it("ordinary values still render", () => {
    expect(isPasswordEvent("email_changed")).toBe(false);
    expect(formatAuditValue("email_changed", "a@b.test")).toBe("a@b.test");
    expect(formatAuditValue("role_changed", null)).toBe("—");
    expect(formatAuditValue("account_identity_changed", { name: "Dakshit", email: "d@x.test" })).toBe("Dakshit · d@x.test");
    expect(formatAuditValue("profile_status_changed", true)).toBe("Yes");
  });
});

describe("the history names the human, not the service role", () => {
  it("an admin acting through the service role is shown by name, with the path as a footnote", () => {
    const a = describeActor({ actor_user_id: "u1", actor_name: "Mithil Mistry", actor_type: "org_admin", execution_context: "service_role", source: "user_management" });
    expect(a.name).toBe("Mithil Mistry");
    expect(a.name.toLowerCase()).not.toContain("service");
    expect(a.note).toBe("via admin service");
  });
  it("an unattributed change is labelled as such and never invents a person", () => {
    const a = describeActor({ actor_user_id: null, actor_name: null, actor_type: "service_role", execution_context: "service_role", source: "database" });
    expect(a.name).toBe("Not attributed");
  });
  it("backfilled and migration rows say what they are", () => {
    expect(describeActor({ actor_user_id: null, actor_name: null, actor_type: "unknown", execution_context: null, source: "historical_backfill" }).name).toBe("Not recorded");
    expect(describeActor({ actor_user_id: null, actor_name: null, actor_type: "migration", execution_context: null, source: "migration" }).name).toBe("Audit history setup");
  });
});
