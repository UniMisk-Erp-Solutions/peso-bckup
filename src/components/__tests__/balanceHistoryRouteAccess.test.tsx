/**
 * DOC-087 — /balance-history route access, using the REAL react-router-dom.
 *
 * src/test/setup.ts globally mocks useNavigate/useParams/Navigate. That makes
 * navigation assertions meaningless — a redirect would "pass" because Navigate
 * is a stub, not because routing happened. This suite restores the real module
 * so ProtectedRoute's redirects are genuinely exercised, and asserts the router
 * landed on the expected path.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  MemoryRouter,
} from "react-router-dom";
import { ProtectedRoute } from "../ProtectedRoute";
import { useAuth } from "@/contexts/AuthContext";
import { MobileBottomNav } from "../mobile/MobileBottomNav";

// Restore the genuine router for this file only. vi.mock is hoisted above the
// imports, so the router import below still resolves to the real module.
vi.mock("react-router-dom", async (importOriginal) => await importOriginal());

vi.mock("@/contexts/SystemAvailabilityContext", () => ({
  useSystemAvailability: () => ({ blocking: false, initializing: false }),
}));
vi.mock("@/hooks/useAllowCashierExpenseSubmission", () => ({
  useAllowCashierExpenseSubmission: () => ({ allowCashierExpenseSubmission: null }),
}));

function mockAuth(userRole: string) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u-1" },
    userRole,
    loading: false,
    isTenantHost: false,
    tenantHostOrgId: null,
    tenantSubdomainLabel: null,
    signOut: vi.fn(),
    isAccountantCashier: false,
  } as unknown as ReturnType<typeof useAuth>);
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

function renderRoute() {
  const router = createMemoryRouter(
    [
      {
        path: "/balance-history",
        element: (
          <>
            <ProtectedRoute allowedRoles={["employee"]}>
              <div>Balance History Page</div>
            </ProtectedRoute>
            <LocationProbe />
          </>
        ),
      },
      {
        path: "/dashboard",
        element: (
          <>
            <div>Dashboard Page</div>
            <LocationProbe />
          </>
        ),
      },
    ],
    { initialEntries: ["/balance-history"] },
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/balance-history route access", () => {
  it("lets an employee through", async () => {
    mockAuth("employee");
    renderRoute();

    expect(await screen.findByText("Balance History Page")).toBeInTheDocument();
    expect(screen.getByTestId("pathname")).toHaveTextContent("/balance-history");
  });

  it.each(["admin", "cashier", "engineer", "team_leader", "executive"])(
    "redirects %s to the dashboard",
    async (role) => {
      mockAuth(role);
      renderRoute();

      // A real redirect, not a mocked <Navigate> placeholder.
      await waitFor(() =>
        expect(screen.getByTestId("pathname")).toHaveTextContent("/dashboard"),
      );
      expect(screen.queryByText("Balance History Page")).not.toBeInTheDocument();
    },
  );

  it("uses the real router, not the global setup stub", () => {
    // Guards against setup.ts silently re-mocking navigation for this file.
    expect(vi.isMockFunction(useLocation)).toBe(false);
  });
});

describe("Mobile bottom nav — More active state", () => {
  it("marks More active on /balance-history for an employee", () => {
    mockAuth("employee");
    render(
      <MemoryRouter initialEntries={["/balance-history"]}>
        <MobileBottomNav onMorePress={vi.fn()} />
      </MemoryRouter>,
    );

    const more = screen.getByLabelText("More options");
    expect(more.className).toContain("text-primary");
  });

  it("does not mark More active on a direct tab such as /expenses", () => {
    mockAuth("employee");
    render(
      <MemoryRouter initialEntries={["/expenses"]}>
        <MobileBottomNav onMorePress={vi.fn()} />
      </MemoryRouter>,
    );

    const more = screen.getByLabelText("More options");
    expect(more.className).toContain("text-muted-foreground");
  });
});
