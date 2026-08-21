/**
 * Proves LocalPesoWiseBootstrap is the ONLY place bootstrapAuthSession()
 * (local-Supabase session bootstrap) is called from, and that it still runs
 * on mount exactly as src/main.tsx used to do unconditionally — see
 * docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §21 regression list.
 *
 * App, AuthProvider, I18nProvider and SystemAvailabilityProvider are all
 * mocked to trivial stubs — this test's job is LocalPesoWiseBootstrap's own
 * mount behavior, not a full app render (see the established
 * disproportionate-full-render precedent already documented elsewhere in
 * this test suite, e.g. reviewActionReliability.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const bootstrapAuthSession = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/authSession", () => ({
  bootstrapAuthSession: (...args: unknown[]) => bootstrapAuthSession(...args),
}));

vi.mock("@/contexts/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/i18n/I18nProvider", () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/contexts/SystemAvailabilityContext", () => ({
  SystemAvailabilityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/App", () => ({
  default: () => <div data-testid="local-app-stub">local app</div>,
}));

import { LocalPesoWiseBootstrap } from "../LocalPesoWiseBootstrap";

beforeEach(() => {
  bootstrapAuthSession.mockClear();
});

describe("LocalPesoWiseBootstrap", () => {
  it("calls bootstrapAuthSession() on mount", async () => {
    render(<LocalPesoWiseBootstrap />);
    await waitFor(() => expect(bootstrapAuthSession).toHaveBeenCalledTimes(1));
  });

  it("renders the local app (App) once the bootstrap race settles", async () => {
    render(<LocalPesoWiseBootstrap />);
    expect(await screen.findByTestId("local-app-stub")).toBeInTheDocument();
  });

  it("renders nothing before the bootstrap race settles (no loading-UI flash)", async () => {
    let resolveBootstrap: () => void = () => {};
    bootstrapAuthSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveBootstrap = resolve; }),
    );
    const { container } = render(<LocalPesoWiseBootstrap />);
    expect(container).toBeEmptyDOMElement();
    await act(async () => {
      resolveBootstrap();
    });
  });
});
