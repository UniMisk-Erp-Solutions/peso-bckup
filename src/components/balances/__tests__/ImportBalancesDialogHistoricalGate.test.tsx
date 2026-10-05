/**
 * FINAL VISIBILITY PASS (2026-08-26) — Historical Balance / Tally visibility
 * vs. mutation readiness.
 *
 * This file previously encoded the OLD, now-fixed bug: a single
 * `historicalAvailable = flagOn && backendReady` gate controlled BOTH
 * whether Tally/Opening Balance/Balance Update were even shown on screen
 * AND whether their RPCs could be called -- so a missing backend migration
 * (a 404 on balance_historical_v2_capabilities_v1, expected on any
 * environment that hasn't run the Historical Balance V2 migrations yet)
 * made the entire Tally import FORMAT disappear from the UI. That is never
 * correct: Tally is a file format admins must be able to discover and
 * preview regardless of the accounting engine's rollout status.
 *
 * The corrected model has three independent concepts:
 * - historicalFlagOn: the org admin enabled the feature in Master Admin.
 * - historicalBackendReady: the server actually has the V2 RPCs installed.
 * - historicalMutationReady = flagOn && backendReady -- required before ANY
 *   RPC that writes to the database (stageAndValidate/validateImportBatchV2/
 *   applyImportBatchV2/reverseImportBatchV2) is called for a historical mode.
 *
 * VISIBILITY RULES (never gated on backend readiness):
 * - The Tally source, and Opening Balance/Balance Update WHEN Tally is
 *   selected, are ALWAYS offered -- flag on or off, backend ready or not.
 * - Opening Balance/Balance Update for the PesoWise starter-sheet source
 *   are offered when historicalFlagOn (flag alone, backend irrelevant to
 *   whether they're OFFERED -- only to whether Continue actually works).
 * - Allocation is always available regardless of any of this.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImportBalancesDialog } from "../ImportBalancesDialog";

const hasOrganizationFeatureMock = vi.fn();
const useBalanceHistoricalV2CapabilityMock = vi.fn();
const useBalanceAdditiveV3CapabilityMock = vi.fn();

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ hasOrganizationFeature: hasOrganizationFeatureMock }),
}));

vi.mock("@/lib/balanceHistoricalV2Capability", () => ({
  useBalanceHistoricalV2Capability: () => useBalanceHistoricalV2CapabilityMock(),
}));

vi.mock("@/lib/balanceAdditiveV3Capability", () => ({
  useBalanceAdditiveV3Capability: () => useBalanceAdditiveV3CapabilityMock(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  organizationId: "org-1",
};

// Additive Credit V3 (2026-09-01): the dialog's mode selector now defaults
// to opening_credit/balance_credit, which check the NEW v3 capability, not
// the old v2 one -- both are set identically here so these pre-existing
// visibility tests (written against the old anchor engine) exercise the
// same flag-on/backend-ready combinations against whichever engine the
// currently-selected mode actually needs.
function setGate(flagOn: boolean, capability: { ready: boolean; loading: boolean }) {
  hasOrganizationFeatureMock.mockReturnValue(flagOn);
  useBalanceHistoricalV2CapabilityMock.mockReturnValue({ ...capability, functions: {} });
  useBalanceAdditiveV3CapabilityMock.mockReturnValue({ ...capability, functions: {} });
}

beforeEach(() => {
  hasOrganizationFeatureMock.mockReset();
  useBalanceHistoricalV2CapabilityMock.mockReset();
  useBalanceAdditiveV3CapabilityMock.mockReset();
});

function selectTallySource() {
  fireEvent.click(screen.getByRole("radio", { name: /Tally Group Summary export/i }));
}

describe("Tally source visibility — NEVER depends on flag or backend readiness", () => {
  it("HARD REQUIREMENT: Tally is visible with the feature flag OFF and the backend missing (404)", () => {
    setGate(false, { ready: false, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);

    expect(screen.getByRole("radio", { name: /Tally Group Summary export/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /PesoWise starter sheet/i })).toBeInTheDocument();
  });

  it("selecting Tally with everything off still offers Opening Balance and Balance Update, and hides Allocation", () => {
    setGate(false, { ready: false, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);

    selectTallySource();

    expect(screen.getByRole("radio", { name: /^Opening Balance/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Balance Credit/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^Allocation/ })).not.toBeInTheDocument();
  });

  it("Tally remains visible and selectable when the flag is on and the backend is ready too", () => {
    setGate(true, { ready: true, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);

    expect(screen.getByRole("radio", { name: /Tally Group Summary export/i })).toBeInTheDocument();
    selectTallySource();
    expect(screen.getByRole("radio", { name: /^Opening Balance/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Balance Credit/ })).toBeInTheDocument();
  });
});

describe("PesoWise starter-sheet source — Opening Balance/Balance Update gated on the feature flag alone", () => {
  it("flag OFF: hidden, regardless of backend state", () => {
    setGate(false, { ready: false, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);

    // Default source is "template".
    expect(screen.queryByRole("radio", { name: /^Opening Balance/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^Balance Credit/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Allocation/ })).toBeInTheDocument();
  });

  it("flag ON, backend missing: VISIBLE (selectable/previewable), even though Continue will be blocked later", () => {
    setGate(true, { ready: false, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);

    expect(screen.getByRole("radio", { name: /^Opening Balance/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Balance Credit/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Allocation/ })).toBeInTheDocument();
  });

  it("flag ON, backend ready: visible", () => {
    setGate(true, { ready: true, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);

    expect(screen.getByRole("radio", { name: /^Opening Balance/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Balance Credit/ })).toBeInTheDocument();
  });
});

describe("Backend-missing banner — informational only, never hides anything", () => {
  it("shows when mutation isn't ready (flag off)", () => {
    setGate(false, { ready: false, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);
    expect(screen.getByText(/require the latest PesoWise backend update/i)).toBeInTheDocument();
  });

  it("shows when mutation isn't ready (flag on, backend missing)", () => {
    setGate(true, { ready: false, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);
    expect(screen.getByText(/require the latest PesoWise backend update/i)).toBeInTheDocument();
  });

  it("does not show while the capability check is still loading (never a premature warning)", () => {
    setGate(true, { ready: false, loading: true });
    render(<ImportBalancesDialog {...defaultProps} />);
    expect(screen.queryByText(/require the latest PesoWise backend update/i)).not.toBeInTheDocument();
  });

  it("does not show once flag on + backend ready", () => {
    setGate(true, { ready: true, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);
    expect(screen.queryByText(/require the latest PesoWise backend update/i)).not.toBeInTheDocument();
  });
});

describe("Allocation — always available, unaffected by flag/backend state", () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])("flagOn=%s backendReady=%s -> Allocation still offered for the starter-sheet source", (flagOn, ready) => {
    setGate(flagOn, { ready, loading: false });
    render(<ImportBalancesDialog {...defaultProps} />);
    expect(screen.getByRole("radio", { name: /^Allocation/ })).toBeInTheDocument();
  });
});

describe("initialSource prop — the direct 'Import from Tally' entry point", () => {
  it("opens straight into the Tally upload step, with everything off", () => {
    setGate(false, { ready: false, loading: false });
    render(<ImportBalancesDialog {...defaultProps} initialSource="tally" />);

    // Skips the "type" step entirely -- lands directly on the Tally upload UI.
    expect(screen.getByText(/Upload Tally Group Summary/i)).toBeInTheDocument();
    expect(document.querySelector('input[type="file"][accept=".xlsx"]')).toBeInTheDocument();
  });
});
