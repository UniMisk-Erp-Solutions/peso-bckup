/**
 * Master Admin redesign (DOC-165): the compact list, the organization management tabs and the
 * Features tab (draft + Save / Cancel). These are presentational components, so every write is
 * asserted as a callback; nothing here touches Supabase.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrganizationsTable } from "../OrganizationsTable";
import { OrganizationManagement } from "../OrganizationManagement";
import { FeaturesTab } from "../FeaturesTab";
import type { Organization } from "../types";

const org = (over: Partial<Organization> = {}): Organization => ({
  id: "org-1",
  name: "Acme Travels",
  slug: "acme",
  plan: "pro",
  payment_status: "active",
  is_blocked: false,
  last_activity_at: "2026-10-17T13:24:00Z",
  created_at: "2026-01-02T10:00:00Z",
  max_users: 50,
  subdomain: "acme",
  strategy_slug: "standard",
  ...over,
});

describe("OrganizationsTable", () => {
  it("shows the compact columns and no feature checkboxes", () => {
    render(
      <OrganizationsTable
        organizations={[org()]}
        memberCountByOrgId={{ "org-1": 5 }}
        blockedByFlag={{}}
        onManage={() => {}}
      />,
    );
    for (const h of ["Organization", "Plan", "Users", "Payment", "Status", "Last active", "Actions"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    expect(screen.getByText("5 / 50")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("opens an organization from the name or the Manage button", async () => {
    const onManage = vi.fn();
    render(
      <OrganizationsTable organizations={[org()]} memberCountByOrgId={{}} blockedByFlag={{}} onManage={onManage} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Manage/ }));
    await userEvent.click(screen.getByText("Acme Travels"));
    expect(onManage).toHaveBeenCalledTimes(2);
    expect(onManage).toHaveBeenCalledWith("org-1");
  });

  it("marks an organization Blocked when the flag or the legacy column says so", () => {
    render(
      <OrganizationsTable
        organizations={[org({ id: "a", name: "Flagged" }), org({ id: "b", name: "Legacy", is_blocked: true }), org({ id: "c", name: "Fine" })]}
        memberCountByOrgId={{}}
        blockedByFlag={{ a: true }}
        onManage={() => {}}
      />,
    );
    expect(screen.getAllByText("Blocked")).toHaveLength(2);
    expect(screen.getAllByText("Active")).toHaveLength(1);
  });

  it("filters by name or slug", async () => {
    render(
      <OrganizationsTable
        organizations={[org({ id: "a", name: "Alpha", slug: "alpha" }), org({ id: "b", name: "Beta", slug: "beta" })]}
        memberCountByOrgId={{}}
        blockedByFlag={{}}
        onManage={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText("Search organizations"), "bet");
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("shows the empty state", () => {
    render(<OrganizationsTable organizations={[]} memberCountByOrgId={{}} blockedByFlag={{}} onManage={() => {}} />);
    expect(screen.getByText("No organizations")).toBeInTheDocument();
  });
});

describe("FeaturesTab", () => {
  it("groups flags by category, hides org_blocked, and starts with Save disabled", () => {
    render(<FeaturesTab orgId="org-1" saved={{ teams_enabled: true }} onSave={async () => {}} />);
    expect(screen.getByText("Access & login")).toBeInTheDocument();
    expect(screen.getByText("Teams & approvals")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Block Organization/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("searches features", async () => {
    render(<FeaturesTab orgId="org-1" saved={{}} onSave={async () => {}} />);
    await userEvent.type(screen.getByLabelText("Search features"), "tally");
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    await userEvent.clear(screen.getByLabelText("Search features"));
    await userEvent.type(screen.getByLabelText("Search features"), "zzzz-nope");
    expect(screen.getByText("No features match your search.")).toBeInTheDocument();
  });

  it("saves only the changed flags", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<FeaturesTab orgId="org-1" saved={{ teams_enabled: true }} onSave={onSave} />);
    const switches = screen.getAllByRole("switch");
    // turn the first flag (employee_id_login) on and teams_enabled off
    await userEvent.click(switches[0]);
    await userEvent.click(screen.getByRole("switch", { name: /Teams/i }));
    expect(screen.getByText("2 unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const sent = onSave.mock.calls[0][0] as { key: string; enabled: boolean }[];
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(
      expect.arrayContaining([
        { key: "employee_id_login", enabled: true },
        { key: "teams_enabled", enabled: false },
      ]),
    );
  });

  it("Cancel discards the draft without saving", async () => {
    const onSave = vi.fn();
    render(<FeaturesTab orgId="org-1" saved={{}} onSave={onSave} />);
    await userEvent.click(screen.getAllByRole("switch")[0]);
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("OrganizationManagement", () => {
  const baseProps = () => ({
    org: org(),
    memberCount: 5,
    flags: {} as Record<string, boolean>,
    blocked: false,
    flagBlocked: false,
    appBaseDomain: "example.test",
    showTenantSubdomain: true,
    showTenantStrategy: true,
    showTenantFeatures: true,
    strategiesList: [{ slug: "standard", label: "Standard" }],
    updating: false,
    onBack: vi.fn(),
    onCopyId: vi.fn(),
    onUpdate: vi.fn(),
    onSaveFeatures: vi.fn().mockResolvedValue(undefined),
    onBlock: vi.fn(),
    onUnblock: vi.fn(),
  });

  it("has the six tabs and goes back", async () => {
    const props = baseProps();
    render(<OrganizationManagement {...props} />);
    for (const name of ["Overview", "Features", "Plan & Billing", "Users", "Activity", "Security"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("button", { name: "Back to organizations" }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it("Overview holds tenant subdomain and strategy", () => {
    render(<OrganizationManagement {...baseProps()} />);
    expect(screen.getByDisplayValue("acme")).toBeInTheDocument();
    expect(screen.getByText("Tenant settings")).toBeInTheDocument();
  });

  it("Users tab holds the user limit and saves it on blur", async () => {
    const props = baseProps();
    render(<OrganizationManagement {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Users" }));
    const input = screen.getByPlaceholderText("Unlimited");
    await userEvent.clear(input);
    await userEvent.type(input, "75");
    await userEvent.tab();
    expect(props.onUpdate).toHaveBeenCalledWith({ max_users: 75 });
  });

  it("Security tab offers Block for an active organization", async () => {
    const props = baseProps();
    render(<OrganizationManagement {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Security" }));
    await userEvent.click(screen.getByRole("button", { name: "Block organization" }));
    expect(props.onBlock).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Unblock organization" })).toBeNull();
  });

  it("Security tab offers Unblock for a blocked organization", async () => {
    const props = { ...baseProps(), blocked: true, flagBlocked: true };
    render(<OrganizationManagement {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Security" }));
    const panel = screen.getByRole("tabpanel");
    await userEvent.click(within(panel).getByRole("button", { name: "Unblock organization" }));
    expect(props.onUnblock).toHaveBeenCalled();
  });
});
