/**
 * DOC-158: the Audit History dialog shows who/what/when/from where, the identity AT THE TIME, and never a credential value.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

const timeline = vi.fn();
vi.mock("@/lib/userAccountAudit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/userAccountAudit")>("@/lib/userAccountAudit");
  return { ...actual, fetchUserIdentityTimeline: (...a: unknown[]) => timeline(...a) };
});

import { UserAuditHistoryDialog } from "@/components/UserAuditHistoryDialog";

const ev = (over: Record<string, unknown>) => ({
  event_id: String(Math.random()), occurred_at: "2026-10-22T05:29:00Z", event_type: "profile_updated", summary: "", actor_user_id: "a1",
  actor_name: "Mithil Mistry", actor_type: "org_admin", source: "user_management", field_name: null, old_value: null, new_value: null,
  identity_name: "Krish Patel", identity_email: "krish@patidartravels.com", request_id: "r1", execution_context: "authenticated", ...over,
});

beforeEach(() => timeline.mockReset());

describe("UserAuditHistoryDialog", () => {
  it("lists events newest first, naming the human actor and the frozen identity at the time", async () => {
    timeline.mockResolvedValue([
      ev({ event_id: "1", occurred_at: "2026-10-22T05:26:00Z", event_type: "user_reactivated", identity_name: "Krish Patel" }),
      ev({ event_id: "2", occurred_at: "2026-10-22T05:29:00Z", event_type: "email_changed", field_name: "auth.email",
           old_value: "krish@patidartravels.com", new_value: "dakshit@patidartravels.com", execution_context: "service_role" }),
      ev({ event_id: "3", occurred_at: "2026-10-22T05:30:00Z", event_type: "profile_updated", field_name: "name",
           old_value: "Krish Patel", new_value: "Dakshit Prajapati" }),
    ]);
    render(<UserAuditHistoryDialog open onOpenChange={() => {}} organizationId="org" userId="u" userName="Dakshit Prajapati" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-event")).toHaveLength(3));
    const rows = screen.getAllByTestId("audit-event");
    expect(within(rows[0]).getByText("Profile updated")).toBeInTheDocument();       // newest first
    expect(within(rows[2]).getByText("User reactivated")).toBeInTheDocument();
    const emailRow = rows[1];
    expect(within(emailRow).getByText("Mithil Mistry")).toBeInTheDocument();         // the human, not service_role
    expect(emailRow.textContent).toContain("via admin service");
    expect(emailRow.textContent).not.toMatch(/Changed by:\s*service/i);
    expect(emailRow.textContent).toContain("krish@patidartravels.com");              // previous
    expect(emailRow.textContent).toContain("dakshit@patidartravels.com");            // new
    expect(emailRow.textContent).toContain("Account at the time: Krish Patel");      // frozen identity, not the current profile
    expect(emailRow.textContent).toContain("Source: User Management");
  });

  it("shows a password event as an event only: no previous/new, even if a value were somehow present", async () => {
    timeline.mockResolvedValue([ev({ event_type: "password_changed", old_value: "hunter2", new_value: "hunter3", field_name: "password" })]);
    render(<UserAuditHistoryDialog open onOpenChange={() => {}} organizationId="org" userId="u" />);
    await waitFor(() => expect(screen.getByTestId("audit-event")).toBeInTheDocument());
    const text = screen.getByTestId("audit-event").textContent ?? "";
    expect(text).toContain("Password changed");
    expect(text).toContain("No password information is stored");
    expect(text).not.toMatch(/hunter|Previous:|New:/);
  });

  it("marks failed and denied attempts as not completed", async () => {
    timeline.mockResolvedValue([ev({ event_type: "email_change_failed" }), ev({ event_type: "account_change_denied" })]);
    render(<UserAuditHistoryDialog open onOpenChange={() => {}} organizationId="org" userId="u" />);
    await waitFor(() => expect(screen.getAllByText("Not completed")).toHaveLength(2));
  });

  it("is honest about unattributed and backfilled rows", async () => {
    timeline.mockResolvedValue([
      ev({ event_id: "x", event_type: "password_changed", actor_user_id: null, actor_name: null, actor_type: "service_role", source: "database" }),
      ev({ event_id: "y", event_type: "user_deactivated", actor_user_id: null, actor_name: null, actor_type: "unknown", source: "historical_backfill", identity_name: null }),
    ]);
    render(<UserAuditHistoryDialog open onOpenChange={() => {}} organizationId="org" userId="u" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-event")).toHaveLength(2));
    const t = screen.getByTestId("user-audit-history").textContent ?? "";
    expect(t).toContain("Not attributed");
    expect(t).toContain("Not recorded");
    expect(t).toContain("Direct database change (unattributed)");
  });

  it("empty and error states", async () => {
    timeline.mockResolvedValueOnce([]);
    const { unmount } = render(<UserAuditHistoryDialog open onOpenChange={() => {}} organizationId="org" userId="u" />);
    await waitFor(() => expect(screen.getByText(/No audit events have been recorded/)).toBeInTheDocument());
    unmount();
    timeline.mockRejectedValueOnce(new Error("rls"));
    render(<UserAuditHistoryDialog open onOpenChange={() => {}} organizationId="org" userId="u" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
  });

  it("does not query while closed", () => {
    render(<UserAuditHistoryDialog open={false} onOpenChange={() => {}} organizationId="org" userId="u" />);
    expect(timeline).not.toHaveBeenCalled();
  });
});
